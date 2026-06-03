# MCP Tool Design

## Purpose

This document is the authoritative reference for every MCP tool that MCPEmails exposes to AI agents. It covers tool naming, complete input and output schemas, the TypeScript handler pattern, inbox targeting, error taxonomy, security considerations, and the step-by-step process for adding a new tool in the future. Developers implementing or extending the MCP layer should read this document alongside `Documents/MCP/server-concepts.md` and `Documents/Architecture/database-schema.md`.

---

## 1. Overview — The Five MCPEmails Tools

MCPEmails exposes exactly five tools in its initial release. Each tool maps to a single email operation and corresponds to one or more OAuth scopes. The table below summarises the surface area at a glance.

| Tool name | Human title | Required scope | Provider support |
|---|---|---|---|
| `list_inbox` | List Inbox | `read:email` | Gmail, Outlook, Fastmail, IMAP |
| `email_read` | Read Email | `read:email` | Gmail, Outlook, Fastmail, IMAP |
| `email_send` | Send Email | `send:email` | Gmail, Outlook, Fastmail, SMTP |
| `email_reply` | Reply to Email | `send:email` | Gmail, Outlook, Fastmail, SMTP |
| `email_search` | Search Emails | `read:email` | Gmail, Outlook, Fastmail, IMAP |

All five tools are registered on a single MCP server that operates as a Supabase Edge Function exposed at:

```
https://<project-ref>.supabase.co/functions/v1/mcp
```

The server uses the Streamable HTTP transport (not stdio). Each inbound HTTP request carries an `Authorization: Bearer <api-key>` header. The API key is resolved to a workspace and a set of scopes before any tool handler is invoked.

### Capability declaration

During the MCP handshake, the server declares:

```json
{
  "capabilities": {
    "tools": {
      "listChanged": true
    }
  }
}
```

`listChanged: true` is declared because the available tool list can change dynamically: a workspace whose API key has only `read:email` scope sees three tools; a key with both `read:email` and `send:email` sees all five. The server emits `notifications/tools/list_changed` when the effective scope set changes for a connected session, though in practice this happens rarely (typically only when the key is updated in the dashboard while a session is open).

---

## 2. Tool Naming Conventions

### Pattern: `verb_noun`

All MCPEmails tool names follow the pattern `<verb>_<noun>` using snake_case. This is a deliberate choice with four motivations:

**1. Unambiguous action semantics.** The verb comes first, making the tool's intent immediately obvious to a language model reading a tool list. Verbs are drawn from a small controlled vocabulary: `list`, `read`, `send`, `reply_to`, `search`. Each verb implies a distinct class of side effects: `list` and `read` are read-only; `send` and `reply_to` write state to an external system; `search` is read-only but may be computationally expensive.

**2. Natural language alignment.** LLMs are trained on natural language. Tool names that read like English imperative phrases ("list inbox", "read email", "send email") require less token budget to reason about than opaque identifiers like `inbox.list.v2` or `EMAIL_FETCH`.

**3. Grouping by noun for discoverability.** When a model sees multiple tools with the noun `email`, it can infer that those tools operate on the same resource type and differ only in the action. This helps the model select the right tool without reading every description in full.

**4. Consistency with common MCP conventions.** The broader MCP ecosystem tends to use `verb_noun` (e.g., `get_weather`, `create_issue`, `read_file`). Conforming to this pattern reduces cognitive overhead for developers and models already familiar with MCP.

### Deliberate name choices

- **`list_inbox`** rather than `list_emails` or `get_inbox`: The noun `inbox` signals that the result is a mailbox-level view (a list of message summaries), not individual email content. This distinction matters when an agent is deciding whether to call `list_inbox` (to get a preview) or `email_read` (to get the full content of one message).

- **`email_read`** rather than `get_email` or `fetch_email`: `read` implies that the full content is returned, including body text. `get` is ambiguous — it could return just metadata. `fetch` has network-level connotations. `read` is the closest verb to the user-intent.

- **`email_send`** rather than `compose_email` or `create_email`: `send` makes clear that the action is irreversible and has external side effects. `compose` suggests a draft workflow (which would be a separate tool set). `create` is too generic.

- **`email_reply`** rather than `reply_email` or `respond_to_email`: `reply_to` is the natural English preposition for replying. The `_to_` infix also distinguishes this tool from `email_send` in a model's tool selection reasoning: "reply to an existing thread" versus "send a new message."

- **`email_search`** (plural noun) rather than `search_email` or `find_emails`: The plural form signals that the result is always a collection, not a single item. This is the only tool with a plural noun, which consistently marks it as "returns multiple results."

---

## 3. Full Input Schemas

Each tool's `inputSchema` is a JSON Schema (Draft 7) object. All tools share the `inbox_id` parameter — see Section 6 for how it is used.

### 3.1 `list_inbox`

```json
{
  "type": "object",
  "properties": {
    "inbox_id": {
      "type": "string",
      "format": "uuid",
      "description": "UUID of the inbox to list. Must be an inbox in the current workspace that the API key is permitted to access. Obtain inbox UUIDs from the MCPEmails dashboard or by calling this tool with a known inbox_id."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100,
      "default": 20,
      "description": "Maximum number of email summaries to return. Defaults to 20. Larger values increase latency; prefer pagination over large limits."
    },
    "offset": {
      "type": "integer",
      "minimum": 0,
      "default": 0,
      "description": "Zero-based pagination offset. To page through results, increment by the value of 'limit'. The inbox ordering is by received date, newest first."
    },
    "folder": {
      "type": "string",
      "default": "INBOX",
      "description": "Mailbox folder to list. Defaults to 'INBOX'. Common values: 'INBOX', 'SENT', 'DRAFTS', 'TRASH'. Provider-specific folder names are supported (e.g., '[Gmail]/Spam' for Gmail). Case-sensitive."
    },
    "unread_only": {
      "type": "boolean",
      "default": false,
      "description": "When true, return only unread messages. Useful for agents that process unread email as a task queue."
    }
  },
  "required": ["inbox_id"],
  "additionalProperties": false
}
```

**Design notes:** `folder` defaults to `INBOX` because that is the universal mailbox across all providers. The `unread_only` flag exists because it is a very common agent use-case (process my unread mail) and translates directly to efficient server-side filtering at the provider level, avoiding the need for the agent to receive all messages and filter client-side.

---

### 3.2 `email_read`

```json
{
  "type": "object",
  "properties": {
    "inbox_id": {
      "type": "string",
      "format": "uuid",
      "description": "UUID of the inbox that contains the email."
    },
    "message_id": {
      "type": "string",
      "description": "Provider-native message identifier. For Gmail this is the message ID string returned by the Gmail API (e.g., '18a3c2d7f9b1e4a0'). For Outlook it is the Graph API item ID. For IMAP providers it is the UID as a string. Always obtained from a previous call to list_inbox or email_search."
    },
    "include_html": {
      "type": "boolean",
      "default": false,
      "description": "When true, the response includes the sanitized HTML body in addition to the plain-text body. Set to true only when the agent needs to process formatting, links, or structure from the HTML. HTML is sanitized before return — all JavaScript, CSS, and external resource references are stripped."
    },
    "include_attachments": {
      "type": "boolean",
      "default": false,
      "description": "When true, each attachment is included in the response as a base64-encoded data field. Attachments increase response size significantly; request only when the agent needs to process attachment content."
    },
    "mark_as_read": {
      "type": "boolean",
      "default": false,
      "description": "When true, marks the message as read at the provider after successfully fetching its content. This is a write side effect on an otherwise read-only tool; it requires the 'read:email' scope. Defaults to false to avoid unintended state changes."
    }
  },
  "required": ["inbox_id", "message_id"],
  "additionalProperties": false
}
```

**Design notes:** `include_html` and `include_attachments` are opt-in to keep default responses small. Most agents only need the plain-text body. `mark_as_read` is included here rather than as a separate tool because it is semantically coupled to reading — if an agent reads a message and wants to mark it processed, requiring a second tool call adds unnecessary latency and complexity. The opt-in default preserves read-only behaviour unless explicitly requested.

---

### 3.3 `email_send`

```json
{
  "type": "object",
  "properties": {
    "inbox_id": {
      "type": "string",
      "format": "uuid",
      "description": "UUID of the inbox to send from. The email will appear in the recipient's inbox as being sent from the email address associated with this inbox."
    },
    "to": {
      "type": "array",
      "items": {
        "type": "string",
        "format": "email"
      },
      "minItems": 1,
      "maxItems": 50,
      "description": "List of recipient email addresses. Each address must be a valid RFC 5322 address. Maximum 50 recipients per message."
    },
    "cc": {
      "type": "array",
      "items": {
        "type": "string",
        "format": "email"
      },
      "default": [],
      "description": "List of CC recipient email addresses. Optional. Same validation as 'to'."
    },
    "bcc": {
      "type": "array",
      "items": {
        "type": "string",
        "format": "email"
      },
      "default": [],
      "description": "List of BCC recipient email addresses. Optional. BCC recipients are not visible to other recipients."
    },
    "subject": {
      "type": "string",
      "minLength": 1,
      "maxLength": 998,
      "description": "Email subject line. Must be non-empty. Maximum 998 characters per RFC 5322. The subject is sent as-is; the tool does not add 'Re:' or other prefixes."
    },
    "body": {
      "type": "string",
      "minLength": 1,
      "description": "Email body as plain text. The tool sends a multipart/alternative message with both a text/plain part (this field) and a text/html part (if html_body is also provided). If only body is provided, the message is sent as text/plain only."
    },
    "html_body": {
      "type": "string",
      "description": "Optional HTML version of the email body. Must be valid HTML. The tool does not sanitize this field before sending — the caller is responsible for ensuring the HTML is safe and correctly structured. If provided, the message is sent as multipart/alternative with this as the text/html part."
    },
    "attachments": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "filename": {
            "type": "string",
            "description": "Filename for the attachment as it will appear to the recipient."
          },
          "mime_type": {
            "type": "string",
            "description": "MIME type of the attachment (e.g., 'application/pdf', 'image/png')."
          },
          "data": {
            "type": "string",
            "description": "Base64-encoded content of the attachment."
          }
        },
        "required": ["filename", "mime_type", "data"]
      },
      "default": [],
      "maxItems": 20,
      "description": "Optional list of file attachments. Maximum 20 attachments. Total attachment size must not exceed 10 MB."
    },
    "reply_to": {
      "type": "string",
      "format": "email",
      "description": "Optional Reply-To header address. When the recipient clicks 'Reply', their email client will address the reply to this address rather than the sender address."
    }
  },
  "required": ["inbox_id", "to", "subject", "body"],
  "additionalProperties": false
}
```

**Design notes:** `to` is an array (not a string) from the start because multi-recipient sending is a common real-world scenario and parsing a comma-separated string is error-prone. The `html_body` is optional; most agent-generated emails are plain text and the plain-text path avoids the complexity of HTML sanitization on the send path. The 10 MB attachment limit is enforced by MCPEmails before hitting the provider to prevent memory exhaustion in the Edge Function.

---

### 3.4 `email_reply`

```json
{
  "type": "object",
  "properties": {
    "inbox_id": {
      "type": "string",
      "format": "uuid",
      "description": "UUID of the inbox that contains the original message and from which the reply will be sent."
    },
    "message_id": {
      "type": "string",
      "description": "Provider-native message identifier of the email being replied to. The tool uses this to set the In-Reply-To and References headers correctly, maintaining thread continuity."
    },
    "body": {
      "type": "string",
      "minLength": 1,
      "description": "Plain-text body of the reply. The tool does not automatically quote the original message — the caller should include quoted text if desired."
    },
    "html_body": {
      "type": "string",
      "description": "Optional HTML version of the reply body. If provided, the reply is sent as multipart/alternative."
    },
    "reply_all": {
      "type": "boolean",
      "default": false,
      "description": "When true, the reply is addressed to all recipients of the original message (To and Cc), not just the sender. When false (default), the reply goes only to the original sender."
    },
    "attachments": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "filename": { "type": "string" },
          "mime_type": { "type": "string" },
          "data": { "type": "string", "description": "Base64-encoded content." }
        },
        "required": ["filename", "mime_type", "data"]
      },
      "default": [],
      "maxItems": 20,
      "description": "Optional attachments to include with the reply."
    }
  },
  "required": ["inbox_id", "message_id", "body"],
  "additionalProperties": false
}
```

**Design notes:** `email_reply` does not expose `to`, `cc`, `bcc`, or `subject` as parameters because they are derived from the original message. The `subject` will be prefixed with `Re:` automatically (or left unchanged if it already starts with `Re:`). The `reply_all` flag is a boolean rather than an explicit `to` array to keep the API simple and to delegate the recipient resolution to the provider's native reply logic, which correctly handles list-unsubscribe headers and other edge cases.

---

### 3.5 `email_search`

```json
{
  "type": "object",
  "properties": {
    "inbox_id": {
      "type": "string",
      "format": "uuid",
      "description": "UUID of the inbox to search."
    },
    "query": {
      "type": "string",
      "minLength": 1,
      "description": "Search query string. The query syntax is provider-specific. For Gmail, use Gmail search operators (e.g., 'from:alice@example.com subject:report after:2026/01/01'). For Outlook/Graph, the query is passed as a $search parameter. For IMAP providers, the query is translated to IMAP SEARCH criteria (only a subset of operators is supported). See provider-specific search syntax notes in the MCPEmails documentation."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100,
      "default": 20,
      "description": "Maximum number of matching emails to return. Defaults to 20."
    },
    "offset": {
      "type": "integer",
      "minimum": 0,
      "default": 0,
      "description": "Pagination offset for search results. Note: not all providers support stable offset-based pagination for search results; if the result set changes between calls, pages may overlap or skip items."
    },
    "include_folders": {
      "type": "array",
      "items": { "type": "string" },
      "default": [],
      "description": "Restrict search to these folder names. Empty array (default) searches all folders. Provider support varies — Gmail ignores this field (Gmail search is inbox-wide); IMAP providers support per-folder search."
    }
  },
  "required": ["inbox_id", "query"],
  "additionalProperties": false
}
```

**Design notes:** The `query` field passes through to the provider's native search rather than implementing a custom query language. This is intentional: email provider search engines are mature, handle edge cases (encoding, threading, date math) correctly, and are already familiar to users who write email search queries. A custom query language would require a translation layer that can never be perfectly faithful and would need maintenance as provider APIs evolve. The limitation — each provider has a slightly different query syntax — is documented clearly so agents can adapt. Future versions may introduce a normalized query DSL that translates to provider-specific syntax.

---

## 4. Full Output Schemas

Tool results are returned in the MCP `content` array as `text/json` content objects. Each tool returns both a human-readable text summary and a structured JSON object in the `structuredContent` field. For backwards compatibility, the structured JSON is also serialized as a string inside a `TextContent` block.

### 4.1 `list_inbox` — output

```json
{
  "messages": [
    {
      "id": "18a3c2d7f9b1e4a0",
      "from": {
        "name": "Alice Nguyen",
        "email": "alice@example.com"
      },
      "to": [
        { "name": "Bob Smith", "email": "bob@example.com" }
      ],
      "subject": "Q2 Forecast Report",
      "date": "2026-05-24T10:30:00Z",
      "preview": "Hi Bob, please find the Q2 forecast attached...",
      "is_read": false,
      "has_attachments": true,
      "folder": "INBOX",
      "thread_id": "18a3c2d7f9b1e4a0"
    }
  ],
  "total": 347,
  "has_more": true,
  "next_offset": 20
}
```

**Field descriptions:**

| Field | Type | Description |
|---|---|---|
| `messages` | array | Ordered list of email summaries, newest first |
| `messages[].id` | string | Provider-native message ID; use in `email_read` or `email_reply` |
| `messages[].from` | object | Sender name and email address |
| `messages[].to` | array | Primary recipients |
| `messages[].subject` | string | Email subject line |
| `messages[].date` | string (ISO 8601) | Date the message was received |
| `messages[].preview` | string | First 200 characters of the plain-text body, whitespace-normalized |
| `messages[].is_read` | boolean | Whether the message has been read |
| `messages[].has_attachments` | boolean | Whether the message has one or more attachments |
| `messages[].folder` | string | Folder where this message resides |
| `messages[].thread_id` | string | Provider thread/conversation ID |
| `total` | integer | Estimated total messages in the folder (may be approximate for IMAP) |
| `has_more` | boolean | Whether more messages exist beyond this page |
| `next_offset` | integer | Pass as `offset` in the next call to retrieve the next page |

---

### 4.2 `email_read` — output

```json
{
  "id": "18a3c2d7f9b1e4a0",
  "thread_id": "18a3c2d7f9b1e4a0",
  "from": { "name": "Alice Nguyen", "email": "alice@example.com" },
  "to": [{ "name": "Bob Smith", "email": "bob@example.com" }],
  "cc": [],
  "bcc": [],
  "reply_to": null,
  "subject": "Q2 Forecast Report",
  "date": "2026-05-24T10:30:00Z",
  "body_text": "Hi Bob,\n\nPlease find the Q2 forecast attached.\n\nBest,\nAlice",
  "body_html": null,
  "attachments": [],
  "is_read": true,
  "labels": ["INBOX", "IMPORTANT"],
  "in_reply_to": null,
  "references": []
}
```

**Field descriptions:**

| Field | Type | Notes |
|---|---|---|
| `id` | string | Provider message ID |
| `thread_id` | string | Thread/conversation ID |
| `from` | object | Sender |
| `to` / `cc` / `bcc` | array | Recipients; `bcc` is always empty for received messages |
| `reply_to` | object or null | Reply-To header if set |
| `subject` | string | Full subject line |
| `date` | string | ISO 8601 timestamp |
| `body_text` | string | Plain-text body, decoded and charset-normalized to UTF-8 |
| `body_html` | string or null | Sanitized HTML body; null unless `include_html: true` was requested |
| `attachments` | array | Empty unless `include_attachments: true` was requested |
| `attachments[].filename` | string | Attachment filename |
| `attachments[].mime_type` | string | MIME type |
| `attachments[].size_bytes` | integer | Size of the attachment in bytes |
| `attachments[].data` | string | Base64-encoded content; only present when `include_attachments: true` |
| `is_read` | boolean | Read status after the call (reflects `mark_as_read` if it was true) |
| `labels` | array | Provider labels/folders (Gmail labels, Outlook categories) |
| `in_reply_to` | string or null | Message-ID of the message this is a reply to |
| `references` | array | Full References header chain for threading |

---

### 4.3 `email_send` — output

```json
{
  "message_id": "18b4d3e8g0c2f5b1",
  "thread_id": "18b4d3e8g0c2f5b1",
  "sent_at": "2026-05-24T11:15:00Z",
  "to": [{ "name": "Carol Wang", "email": "carol@example.com" }],
  "cc": [],
  "bcc": [],
  "subject": "Follow-up on Q2 Forecast",
  "status": "sent"
}
```

**Field descriptions:**

| Field | Type | Description |
|---|---|---|
| `message_id` | string | Provider-assigned ID of the sent message |
| `thread_id` | string | Thread ID (same as `message_id` for new threads) |
| `sent_at` | string | ISO 8601 timestamp when the provider accepted the message |
| `to` / `cc` / `bcc` | array | Resolved recipients as echoed back by the provider |
| `subject` | string | Subject as sent |
| `status` | string | Always `"sent"` on success (errors return `isError: true`) |

---

### 4.4 `email_reply` — output

```json
{
  "message_id": "18b4d3e8g0c2f5b2",
  "thread_id": "18a3c2d7f9b1e4a0",
  "sent_at": "2026-05-24T11:17:00Z",
  "in_reply_to": "18a3c2d7f9b1e4a0",
  "to": [{ "name": "Alice Nguyen", "email": "alice@example.com" }],
  "subject": "Re: Q2 Forecast Report",
  "status": "sent"
}
```

The output schema is the same as `email_send` with one addition: `in_reply_to` carries the original message ID, confirming that the threading headers were set correctly.

---

### 4.5 `email_search` — output

```json
{
  "messages": [
    {
      "id": "18a3c2d7f9b1e4a0",
      "from": { "name": "Alice Nguyen", "email": "alice@example.com" },
      "subject": "Q2 Forecast Report",
      "date": "2026-05-24T10:30:00Z",
      "preview": "Hi Bob, please find the Q2 forecast attached...",
      "is_read": false,
      "has_attachments": true,
      "folder": "INBOX",
      "relevance_score": null
    }
  ],
  "total": 3,
  "has_more": false,
  "next_offset": 20,
  "query_normalized": "from:alice@example.com subject:forecast"
}
```

The `messages` array uses the same schema as `list_inbox`. Additional fields:

| Field | Type | Description |
|---|---|---|
| `total` | integer | Total number of matching messages found |
| `has_more` | boolean | Whether more pages exist |
| `next_offset` | integer | Offset for the next page |
| `query_normalized` | string | The query as interpreted and normalized by the provider (for debugging) |
| `messages[].relevance_score` | number or null | Provider relevance score, if available (Outlook Graph returns this; Gmail and IMAP do not) |

---

## 5. TypeScript Handler Pattern

All tool handlers in the MCPEmails MCP server follow a single interface pattern. This section documents the pattern so that developers adding new tools implement them consistently.

### Core types

```typescript
// The resolved API key context, populated by the authentication middleware
// before any handler is invoked.
interface McpContext {
  workspaceId: string;
  apiKeyId: string;
  scopes: string[];              // e.g. ['read:email', 'send:email']
  permittedInboxIds: string[] | null; // null = all inboxes in workspace
}

// Every tool result that signals success.
interface ToolSuccess<T> {
  content: [{ type: 'text'; text: string }];
  structuredContent: T;
  isError: false;
}

// Every tool result that signals a handled execution error.
interface ToolError {
  content: [{ type: 'text'; text: string }];
  isError: true;
  errorCode: McpEmailErrorCode;
}

type ToolResult<T> = ToolSuccess<T> | ToolError;

// The union of all error codes this server can return as execution errors.
type McpEmailErrorCode =
  | 'inbox_not_found'
  | 'inbox_access_denied'
  | 'message_not_found'
  | 'invalid_recipient'
  | 'scope_denied'
  | 'quota_exceeded'
  | 'rate_limit_exceeded'
  | 'auth_failed'
  | 'provider_error'
  | 'invalid_query'
  | 'search_timeout'
  | 'attachment_too_large';
```

### Handler interface

```typescript
interface ToolHandler<TInput, TOutput> {
  // The tool name as registered in the MCP server.
  readonly name: string;

  // The JSON Schema for the tool's input. Registered with the MCP SDK.
  readonly inputSchema: object;

  // The JSON Schema for the tool's output. Registered as outputSchema.
  readonly outputSchema: object;

  // Required scopes. The middleware checks this before calling execute().
  readonly requiredScopes: string[];

  // The handler implementation. Throws only for unrecoverable programmer
  // errors; all expected failures are returned as ToolError.
  execute(
    args: TInput,
    context: McpContext,
    supabase: SupabaseClient  // service-role client for this invocation
  ): Promise<ToolResult<TOutput>>;
}
```

### Concrete example: `list_inbox` handler skeleton

```typescript
import type { ToolHandler, McpContext, ToolResult } from './types';
import { resolveInbox } from './inbox-resolver';
import { buildEmailProvider } from './providers';
import { logActivity } from './activity';

interface ListInboxInput {
  inbox_id: string;
  limit?: number;
  offset?: number;
  folder?: string;
  unread_only?: boolean;
}

interface ListInboxOutput {
  messages: EmailSummary[];
  total: number;
  has_more: boolean;
  next_offset: number;
}

export const listInboxHandler: ToolHandler<ListInboxInput, ListInboxOutput> = {
  name: 'list_inbox',
  requiredScopes: ['read:email'],
  inputSchema: { /* ... full schema from Section 3.1 ... */ },
  outputSchema: { /* ... full schema from Section 4.1 ... */ },

  async execute(args, context, supabase): Promise<ToolResult<ListInboxOutput>> {
    const start = Date.now();

    // 1. Resolve and authorize the inbox.
    const inbox = await resolveInbox(args.inbox_id, context, supabase);
    if (!inbox) {
      await logActivity({ ...context, toolName: this.name, status: 'error',
        errorCode: 'inbox_not_found', durationMs: Date.now() - start });
      return {
        content: [{ type: 'text', text: `Inbox ${args.inbox_id} not found or not accessible.` }],
        isError: true,
        errorCode: 'inbox_not_found',
      };
    }

    // 2. Build the provider client (Gmail API, Graph API, or IMAP client).
    const provider = await buildEmailProvider(inbox);

    // 3. Call the provider.
    let result: ListInboxOutput;
    try {
      result = await provider.listMessages({
        folder: args.folder ?? 'INBOX',
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
        unreadOnly: args.unread_only ?? false,
      });
    } catch (err) {
      const code = classifyProviderError(err);
      await logActivity({ ...context, toolName: this.name, status: 'error',
        errorCode: code, durationMs: Date.now() - start });
      return {
        content: [{ type: 'text', text: `Provider error: ${(err as Error).message}` }],
        isError: true,
        errorCode: code,
      };
    }

    // 4. Log success.
    await logActivity({ ...context, toolName: this.name, status: 'success',
      durationMs: Date.now() - start });

    // 5. Return structured result.
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result),
      }],
      structuredContent: result,
      isError: false,
    };
  },
};
```

### Handler registration

Handlers are registered with the MCP TypeScript SDK:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listInboxHandler } from './handlers/list-inbox';
// ... other handlers

const server = new McpServer({
  name: 'mcpemails',
  version: '1.0.0',
});

const HANDLERS = [
  listInboxHandler,
  readEmailHandler,
  sendEmailHandler,
  replyToEmailHandler,
  searchEmailsHandler,
];

for (const handler of HANDLERS) {
  server.registerTool(
    handler.name,
    {
      description: getToolDescription(handler.name),
      inputSchema: handler.inputSchema,
      outputSchema: handler.outputSchema,
    },
    async (args, _extra) => {
      // The MCP SDK calls this function. We extract context from the
      // request-scoped state that the auth middleware attached.
      const context = getMcpContext(); // from AsyncLocalStorage
      if (!hasRequiredScopes(context.scopes, handler.requiredScopes)) {
        return {
          content: [{ type: 'text', text: `This action requires scope: ${handler.requiredScopes.join(', ')}` }],
          isError: true,
        };
      }
      return handler.execute(args as any, context, getSupabaseClient());
    }
  );
}
```

---

## 6. The `inbox_id` Parameter Pattern

### Why `inbox_id` rather than account name or email address

Every tool that operates on an inbox takes an `inbox_id` parameter — a UUID that identifies a row in the `public.inboxes` table. Three alternatives were considered:

**Option A: Account name string (e.g., `"work-gmail"`).** Rejected because display names are mutable. A user can rename an inbox in the dashboard; if an agent has cached the old name, calls silently break. UUIDs are immutable.

**Option B: Email address (e.g., `"alice@example.com"`).** Rejected because a user could connect the same email address twice (after disconnecting and reconnecting), creating two distinct inbox records. Email address is not a stable identifier within MCPEmails even though it is unique at the provider level.

**Option C: UUID.** Accepted. UUIDs are stable, opaque, and directly join to the `inboxes` table. The slight usability cost (UUIDs are hard to remember) is irrelevant for AI agents, which obtain the UUID programmatically.

### How agents discover inbox IDs

An agent connecting to MCPEmails for the first time does not know any inbox IDs. The discovery flow is:

1. The user copies their inbox UUIDs from the MCPEmails dashboard ("API Access" section) and includes them in the system prompt they give to the agent.
2. Alternatively, the API key creation flow in the dashboard can export a JSON snippet containing the inbox IDs for the key's permitted inboxes. The agent developer includes this in the agent's configuration.

There is intentionally no `inbox_list` MCP tool in the initial release. Adding one would expose workspace metadata (inbox email addresses, provider names) through the MCP channel, which expands the blast radius of a compromised API key. Inbox discovery is a dashboard concern, not an agent-time concern.

### Access control check

Every handler that receives an `inbox_id` calls `resolveInbox()` before proceeding. This function:

1. Queries `public.inboxes` for the given UUID using the service-role client.
2. Verifies that `inbox.workspace_id` matches `context.workspaceId`.
3. If `context.permittedInboxIds` is not null, verifies that the inbox ID is in the permitted set.
4. Verifies that `inbox.status` is `'active'` (not `'pending'`, `'error'`, or `'revoked'`).
5. Returns the full inbox row (including encrypted credential columns needed by the provider client) if all checks pass, or `null` if any check fails.

The function never distinguishes between "inbox does not exist" and "inbox belongs to a different workspace" in its return value — both return `null` and the handler returns an `inbox_not_found` error. This prevents enumeration: a caller cannot distinguish their own non-existent inbox from someone else's inbox.

---

## 7. Error Surface

### Two distinct error mechanisms

MCPEmails tools use both error mechanisms defined by the MCP specification:

**Protocol errors (JSON-RPC level):** Returned when the request itself is malformed or the tool does not exist. These are handled by the MCP SDK and the authentication middleware before any tool handler runs.

| Condition | JSON-RPC error code | Message |
|---|---|---|
| Unknown tool name | `-32601` | `Method not found` |
| Missing required parameter | `-32602` | `Invalid params: <field> is required` |
| Parameter type mismatch | `-32602` | `Invalid params: <field> must be <type>` |
| Invalid API key | `-32001` | `Unauthorized: invalid or revoked API key` |
| Expired API key | `-32001` | `Unauthorized: API key has expired` |

**Execution errors (`isError: true`):** Returned when the tool ran but encountered a recoverable failure. The response has `isError: true` and a descriptive message in `content[0].text`. The `errorCode` field in the result body identifies the error class.

### Per-tool execution error matrix

#### `list_inbox`

| Error code | Cause | Retryable |
|---|---|---|
| `inbox_not_found` | UUID does not exist or does not belong to this workspace or key | No |
| `inbox_access_denied` | Inbox exists but the API key's `inbox_ids` restriction excludes it | No |
| `auth_failed` | Provider rejected the OAuth token (revoked, expired beyond refresh) | No — user must reconnect |
| `rate_limit_exceeded` | MCPEmails per-key rate limit exceeded (100 req/min) | Yes — wait `retry_after` seconds |
| `provider_error` | Provider API returned an unexpected 5xx error | Yes — exponential backoff |

#### `email_read`

| Error code | Cause | Retryable |
|---|---|---|
| `inbox_not_found` | Inbox UUID invalid or inaccessible | No |
| `message_not_found` | Message ID does not exist in the inbox (may have been deleted) | No |
| `auth_failed` | Provider OAuth token invalid | No |
| `rate_limit_exceeded` | Per-key rate limit | Yes |
| `provider_error` | Provider 5xx | Yes |

#### `email_send`

| Error code | Cause | Retryable |
|---|---|---|
| `inbox_not_found` | Inbox UUID invalid or inaccessible | No |
| `scope_denied` | API key does not have `send:email` scope | No |
| `invalid_recipient` | One or more recipient addresses failed RFC 5322 validation | No — fix the address |
| `quota_exceeded` | Provider or MCPEmails daily send limit reached | No — wait until next day |
| `auth_failed` | Provider OAuth token invalid | No |
| `attachment_too_large` | Total attachment size exceeds 10 MB | No — reduce attachments |
| `rate_limit_exceeded` | Per-key rate limit | Yes |
| `provider_error` | Provider 5xx | Yes — but do NOT retry sends blindly; check for duplicate delivery |

**Important:** `email_send` is not idempotent. If a `provider_error` occurs after the provider has accepted the message (a partial failure), retrying will send a duplicate. Agents must handle this carefully. The MCP error response includes a `delivery_status` field when the error occurs after partial acceptance:

```json
{
  "content": [{ "type": "text", "text": "Provider error after message accepted..." }],
  "isError": true,
  "errorCode": "provider_error",
  "delivery_status": "unknown"
}
```

When `delivery_status` is `"unknown"`, the agent should not retry automatically but should alert the user.

#### `email_reply`

| Error code | Cause | Retryable |
|---|---|---|
| `inbox_not_found` | Inbox UUID invalid | No |
| `message_not_found` | Original message no longer exists | No |
| `scope_denied` | API key lacks `send:email` scope | No |
| `auth_failed` | Provider OAuth token invalid | No |
| `quota_exceeded` | Daily send limit | No |
| `rate_limit_exceeded` | Per-key rate limit | Yes |
| `provider_error` | Provider 5xx | Same caution as `email_send` |

#### `email_search`

| Error code | Cause | Retryable |
|---|---|---|
| `inbox_not_found` | Inbox UUID invalid | No |
| `invalid_query` | Query syntax rejected by provider | No — fix the query |
| `search_timeout` | Provider search took longer than 30 seconds | Yes — simplify query |
| `auth_failed` | Provider OAuth token invalid | No |
| `rate_limit_exceeded` | Per-key rate limit | Yes |
| `provider_error` | Provider 5xx | Yes |

### Example error responses

**Execution error (tool ran, business logic failed):**
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Inbox 3f7a8b2c-1d4e-5f6a-7b8c-9d0e1f2a3b4c not found or not accessible to this API key."
      }
    ],
    "isError": true,
    "errorCode": "inbox_not_found"
  }
}
```

**Protocol error (authentication failed before any handler ran):**
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "error": {
    "code": -32001,
    "message": "Unauthorized: invalid or revoked API key"
  }
}
```

**Rate limit execution error with retry guidance:**
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Rate limit exceeded. Please wait 23 seconds before retrying."
      }
    ],
    "isError": true,
    "errorCode": "rate_limit_exceeded",
    "retryAfter": 23
  }
}
```

---

## 8. How to Add a New Tool

This section is a step-by-step guide for a developer who needs to add a tool beyond the initial five. Follow every step in order; skipping steps has caused bugs in the past.

### Step 1: Determine the tool's scope requirements

Before writing any code, decide which existing scope the new tool belongs to, or whether a new scope is needed.

- Read-only operations on email content: `read:email`
- Sending or creating messages: `send:email`
- Draft management: `manage:drafts` (not yet enabled)
- Folder/label operations: `manage:folders` (not yet enabled)

If the new tool does not fit any existing scope, add the new scope to `Documents/Architecture/database-schema.md` in the `api_keys` scopes table and update the scope-to-tool mapping. New scopes require a dashboard UI change to allow users to grant them.

### Step 2: Write the tool specification

Add an entry to this document under Sections 3 and 4 before writing any code. The specification must include:

- Tool name following the `verb_noun` convention
- Human-readable title (for the MCP `title` field)
- Full `inputSchema` as a JSON Schema object
- Full output schema with field descriptions
- Error codes the tool can return
- Security considerations specific to the tool

Get the specification reviewed before proceeding. Changing a tool's schema after it is in use is a breaking change.

### Step 3: Add the error codes

If the tool introduces new error codes not in the existing `McpEmailErrorCode` union type, add them to `src/mcp/types.ts` and document them in Section 7 of this document.

### Step 4: Implement the handler

Create a new file at `supabase/functions/mcp/handlers/<tool-name>.ts`. The file must:

1. Export a constant implementing `ToolHandler<TInput, TOutput>`.
2. Call `resolveInbox()` as the first operation and return `inbox_not_found` if it returns null.
3. Check scope via the context (the middleware enforces this, but a belt-and-suspenders check in the handler is required for `send:email` and `manage:*` scopes).
4. Call `logActivity()` for both success and error paths.
5. Never throw; all errors must be returned as `ToolError` with an appropriate `errorCode`.

### Step 5: Write unit tests

Create `supabase/functions/mcp/handlers/<tool-name>.test.ts` covering:

- Successful execution with a mocked provider
- `inbox_not_found` when `resolveInbox()` returns null
- `scope_denied` when the context lacks the required scope
- Each error code the tool can return
- Correct `activity_log` insertion for both success and error paths

Test coverage must be at or above 80% for the new handler file before the PR can merge.

### Step 6: Register the handler

In `supabase/functions/mcp/server.ts`, import the new handler and add it to the `HANDLERS` array. The registration loop (described in Section 5) will pick it up automatically.

### Step 7: Update the capability declaration (if adding a scope)

If the new tool belongs to a new scope, the `tools/list` response must reflect whether the connecting API key has that scope. Update the scope-filtering logic in `supabase/functions/mcp/tool-filter.ts` to include the new scope-to-tool mapping.

### Step 8: Update the dashboard

The dashboard "API Keys" creation screen lists the available scopes so users can grant them to keys. If the new tool requires a new scope, update:

- `apps/web/components/dashboard/ApiKeyModal.tsx` — add the new scope checkbox
- `apps/web/components/dashboard/Pages.tsx` — update the scope descriptions

### Step 9: Integration test

Add an integration test in `supabase/tests/mcp/<tool-name>.test.ts` that:

1. Creates a workspace with a test inbox.
2. Issues an API key with the required scopes.
3. Calls the tool via the local MCP server.
4. Asserts the correct output schema.
5. Asserts that an `activity_log` row was created.
6. Asserts that the tool is absent from `tools/list` when the key lacks the required scope.

### Step 10: Update documentation

- Add the tool to the summary table in Section 1 of this document.
- Update `Documents/MCP/tools.md` with the human-facing description.
- Update `README.md` if the tool is a major user-facing feature.

---

## 9. Security Considerations Per Tool

### 9.1 `list_inbox` — security

**Access control:** `resolveInbox()` is the primary guard. It enforces workspace membership and per-key inbox restrictions. There is no secondary check; if `resolveInbox()` passes, the key is authorized.

**Information leakage:** The `preview` field in the response contains the first 200 characters of the email body. For an API key scoped to specific inboxes, this is expected. However, developers building agents should be aware that `list_inbox` does reveal email subjects, sender names, and preview text — enough for an agent to understand the general content of emails. Do not issue keys with `read:email` scope to untrusted agents unless the user has explicitly consented to email access.

**Folder enumeration:** The `folder` parameter is passed to the provider. A caller could probe folder names by iterating values and observing which return `inbox_not_found` versus a valid response. This is accepted as low-risk because the caller must already have a valid API key with inbox access.

### 9.2 `email_read` — security

**Full body exposure:** `email_read` returns the complete plain-text body and, if requested, the HTML body. This is potentially sensitive. The access control model relies entirely on the API key's scope and inbox restrictions. There is no per-message access control; if a key can access an inbox, it can read any message in that inbox.

**HTML sanitization:** When `include_html: true` is set, the HTML body is sanitized using `isomorphic-dompurify` before being returned. All `<script>`, `<style>`, event handlers (`onclick`, `onload`, etc.), and external resource references (`src` attributes pointing to external URLs, `<link>` tags) are stripped. This prevents stored XSS if the returned HTML is ever rendered in a browser context. The sanitization is applied on the MCPEmails server side; the client receives only sanitized HTML.

**`mark_as_read` side effect:** This is the only parameter in a read-only tool that causes a write side effect. It requires no additional scope beyond `read:email` because marking a message as read is considered part of the normal reading workflow. However, agents that set `mark_as_read: true` on every call will modify the inbox's read/unread state, which may surprise users. Agent developers should default to `mark_as_read: false` unless there is an explicit reason to change it.

**Attachment data:** Attachment data is base64-encoded binary and can be large. The total size limit is 10 MB per call. The server enforces this limit by summing the sizes of all requested attachments before fetching them; if the total exceeds 10 MB, the call fails with `attachment_too_large` before any provider API call is made.

### 9.3 `email_send` — security

Send is the highest-risk tool because it has external, irreversible side effects. Several defensive layers are applied:

**Recipient validation:** Every address in `to`, `cc`, and `bcc` is validated against RFC 5322 syntax using a well-maintained library (`email-validator` or equivalent) before the message is constructed. Invalid addresses produce an `invalid_recipient` error immediately, before any provider API call. This prevents misaddressed emails caused by agent hallucination of email addresses.

**No recipient injection from subject or body:** The `to`, `cc`, and `bcc` fields are the only sources of recipients. The server never parses recipient addresses from the `subject` or `body` fields. This prevents a class of attacks where a malicious email body contains headers that could be interpreted as additional recipients by a naively implemented send path.

**Scope enforcement:** `email_send` requires the `send:email` scope. The middleware enforces this before the handler runs. The handler also checks it explicitly as a belt-and-suspenders measure. A key with only `read:email` scope cannot call `email_send` and receives a protocol-level error (`-32602`).

**Quota enforcement:** MCPEmails enforces a daily send quota at the workspace level (configurable by plan: 200 for Free, 2,000 for Pro). This prevents a compromised API key from being used to send mass email. The quota is checked against the `activity_log` for `tool_name = 'email_send'` for the current calendar day (UTC).

**HTML body responsibility:** The `html_body` field is not sanitized before sending. The caller is responsible for the HTML content. This is appropriate because the caller is sending an email to an external recipient — the sanitization concern is on the receiving end (email clients handle this). Adding server-side sanitization would destroy intentional HTML formatting (e.g., bold text, links) in legitimate agent-generated HTML emails.

**No SSRF via recipients:** The recipient validation uses an allowlist of valid email address characters per RFC 5322. It does not make any DNS lookups or HTTP requests based on recipient addresses. There is no SSRF risk from the recipient fields.

### 9.4 `email_reply` — security

**Thread integrity:** The tool fetches the original message's `from`, `to`, `cc`, `In-Reply-To`, and `References` headers from the provider before constructing the reply. This ensures threading headers are correct and that the reply is genuinely addressed to the original sender(s). The caller cannot override the `to` address for a reply-all (it is derived from the original `to` and `cc`).

**Reply-all risk:** `reply_all: true` can send a reply to a large number of recipients. The tool caps total recipients at 50 (matching the `email_send` limit) and returns `invalid_recipient` if the original message had more than 50 combined recipients. This prevents accidental mass-reply to large mailing lists.

**Scope:** Same enforcement as `email_send`. `send:email` scope is required.

### 9.5 `email_search` — security

**Query injection:** The `query` string is passed to the provider's search API as a parameter value, never interpolated into an API URL path or SQL string. Gmail API, Microsoft Graph, and IMAP SEARCH all accept the query as a named parameter. There is no SQL injection risk because the provider APIs are not SQL databases from MCPEmails' perspective.

**Query complexity DoS:** Providers impose their own limits on search complexity and timeout. MCPEmails additionally enforces a 30-second timeout on search calls. If the provider does not respond within 30 seconds, the tool returns `search_timeout`. This prevents long-running searches from holding Edge Function execution slots.

**Result set size:** The maximum `limit` is 100. This prevents a single tool call from returning a very large payload that could exhaust memory in the Edge Function or in the agent's context window.

### 9.6 Cross-cutting security: activity logging

Every tool call — success or failure — is recorded in `public.activity_log`. The log entry includes:

- `workspace_id`, `api_key_id`, `inbox_id`
- `tool_name`
- `status`: `'success'`, `'error'`, or `'rate_limited'`
- `error_code` (when applicable)
- `duration_ms`
- `ip_address`, `user_agent` (from the HTTP request)

The log does **not** record:
- Message body content
- Recipient email addresses
- Search query strings
- Any parameter that could contain PII or sensitive data

This ensures the audit trail is useful for security review without becoming a secondary exposure vector. The `activity_log` table is append-only (see `Documents/Architecture/row-level-security.md`); no tool call can modify or delete log entries.

### 9.7 Cross-cutting security: credential handling

When a tool handler calls `resolveInbox()`, the returned inbox row includes the encrypted credential columns (`oauth_access_token`, `oauth_refresh_token`, `imap_password`). These are decrypted in memory inside the Edge Function using the Supabase Vault key. The decrypted values are:

- Never written to any log
- Never included in tool result objects
- Held only for the duration of the provider API call
- Garbage collected immediately after the call completes

The Edge Function runs in Supabase's isolated Deno runtime. Each invocation is a separate process; there is no shared memory between concurrent invocations.

---

*Last updated: 2026-05-24*
*Authors: MCPEmails architecture team*
*Related documents:*
- *`Documents/MCP/server-concepts.md` — MCP protocol primitives*
- *`Documents/MCP/tools.md` — Human-facing tool reference*
- *`Documents/Architecture/database-schema.md` — Database schema*
- *`Documents/Architecture/row-level-security.md` — RLS policies*
- *`Documents/Architecture/authentication-session-management.md` — Auth flows*
- *`Documents/MCP/authentication.md` — API key and OAuth security*
- *`Documents/MCP/error-handling.md` — Error codes and retry strategy*

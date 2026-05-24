# MCP Tools Reference

## Available Tools

### list_inbox

List all emails in an inbox.

**Signature**: `list_inbox(account: string, limit?: number, offset?: number)`

**Parameters**:
- `account` — Inbox identifier (e.g., "work-gmail", "personal")
- `limit` — Max emails to return (default: 20, max: 100)
- `offset` — Pagination offset (default: 0)

**Returns**: Array of email summaries
```json
{
  "messages": [
    {
      "id": "msg_123",
      "from": "sender@example.com",
      "subject": "Test email",
      "date": "2026-05-24T10:30:00Z",
      "preview": "This is a test..."
    }
  ],
  "total": 150
}
```

**Errors**:
- `inbox_not_found` — Inbox doesn't exist
- `auth_failed` — OAuth token expired or invalid
- `rate_limit_exceeded` — API call limit reached

### read_email

Read the full content of an email.

**Signature**: `read_email(account: string, message_id: string)`

**Parameters**:
- `account` — Inbox identifier
- `message_id` — Email message ID

**Returns**: Full email object with headers, body, attachments

**Errors**:
- `message_not_found` — Email doesn't exist
- `auth_failed` — Permission denied

### send_email

Send an email.

**Signature**: `send_email(account: string, to: string, subject: string, body: string, attachments?: File[])`

**Parameters**:
- `account` — Inbox identifier (must have `send:email` scope)
- `to` — Recipient email address
- `subject` — Email subject
- `body` — Email body (HTML or plain text)
- `attachments` — Optional files to attach

**Returns**: Sent message object with ID

**Errors**:
- `invalid_recipient` — Invalid email address
- `scope_denied` — API key lacks `send:email` scope
- `quota_exceeded` — Account hit daily send limit

### reply_to_email

Reply to an existing email.

**Signature**: `reply_to_email(account: string, message_id: string, body: string, attachments?: File[])`

**Parameters**:
- `account` — Inbox identifier
- `message_id` — Original email ID
- `body` — Reply body
- `attachments` — Optional attachments

**Returns**: Sent reply message object

**Errors**:
- `message_not_found` — Original email not found
- `scope_denied` — API key lacks `reply:email` scope

### search_emails

Search emails by query.

**Signature**: `search_emails(account: string, query: string, limit?: number)`

**Parameters**:
- `account` — Inbox identifier
- `query` — Search query (e.g., "from:alice subject:report")
- `limit` — Max results (default: 20)

**Returns**: Array of matching email summaries

**Errors**:
- `invalid_query` — Query syntax error
- `search_timeout` — Search took too long

## Scope System

API keys can be limited to specific scopes:

- `read:email` — `list_inbox`, `read_email`, `search_emails`
- `send:email` — `send_email`
- `reply:email` — `reply_to_email` (implied with `send:email`)

Always check the scopes of the current API key before calling tools.

## Rate Limiting

All API calls are rate limited. If you exceed limits, the tool will return:

```json
{
  "error": "rate_limit_exceeded",
  "retry_after": 60
}
```

Use exponential backoff to retry:
- Wait `retry_after` seconds before retrying
- Double the wait time on each retry (up to 5 minutes)
- Give up after 5 failed attempts

---

**Note**: This is a placeholder. Full tool documentation should be completed with examples and edge cases.

# MCP Tools Reference

The MCPEmails MCP server exposes **28 tools** over a single Streamable HTTP
endpoint (`POST /api/mcp`, MCP 2025-06-18). Tools are grouped by the **scope**
that unlocks them; `tools/list` only returns tools your API key (or OAuth token)
is scoped for. Always call `inbox_list` first to discover inboxes.

## Targeting an inbox (applies to every per-inbox tool)

`inbox_id` is **optional** on every per-inbox tool:

- If the API key can access **exactly one** inbox, it is auto-resolved — pass nothing.
- Otherwise pass **`inbox_id`** (the UUID from `inbox_list`) **or** **`inbox`**
  (the inbox's email address, e.g. `alice@example.com`). `inbox_id` wins if both are given.

## Result envelope

Successful tool results carry a typed `structuredContent` object (in addition to
the text content block). In list/search results, `total` may be `null` when the
provider cannot supply a count, or carry `total_is_estimate: true` on Gmail.
Tool-execution failures return a normal result with `isError: true`.

## Scopes

| Scope | Unlocks |
| --- | --- |
| `read:email` | `inbox_list`, `email_list`, `email_read`, `email_read_batch`, `email_search`, `folder_list` |
| `search:email` | `email_search` (on its own — works in addition to `read:email`) |
| `send:email` | `email_send`, `email_reply`, `email_forward`, `email_archive`, `email_flag` |
| `manage:folders` | `folder_create`, `folder_rename`, `folder_delete`, `email_move`, `email_move_batch`, `email_search_and_move` |
| `delete:email` | `email_delete`, `email_delete_batch`, `email_search_and_delete` |
| `manage:drafts` | `draft_list`, `draft_create`, `draft_update`, `draft_send` |
| `manage:contacts` | `contact_search` |
| `schedule:email` | `schedule_create`, `schedule_list`, `schedule_cancel` |

---

## read:email

### `inbox_list`
No parameters. Returns every inbox the key can access — `inbox_id`, email
address, display name, provider, optional service brand, and a `capabilities`
object. **Call this first.**

### `email_list`
List message summaries (newest first).
Params: `inbox_id?`, `inbox?`, `limit?` (≤100), `offset?`, `folder?` (default `INBOX`), `unread_only?`.

### `email_read`
Fetch one full message.
Params: `inbox_id?`, `inbox?`, `message_id` (required), `include_html?`, `include_attachments?`, `mark_as_read?`.

### `email_read_batch`
**Batch read up to 50 messages in one call.** Returns `{ messages, errors }` — a
bad/missing ID never fails the whole batch. Attachments share a single 10 MB
budget across the call.
Params: `inbox_id?`, `inbox?`, `message_ids` (required, array, ≤50), `include_html?`, `include_attachments?`, `mark_as_read?`.

### `email_search`
Structured, provider-agnostic search — no provider query syntax needed. Fields
are combined with AND; the server translates them to Gmail operators, Outlook
KQL/OData, Fastmail JMAP, or IMAP SEARCH.
Params: `inbox_id?`, `inbox?`, `from?`, `to?`, `cc?`, `subject?`, `body?`,
`text?`, `unread?`, `has_attachment?`, `flagged?`, `since?` (ISO date),
`before?` (ISO date), `query?` (raw escape hatch), `limit?`, `offset?`, `include_folders?`.

Per-provider gaps: generic **IMAP** ignores `has_attachment`; **Outlook**
ignores `flagged`; **Fastmail** ignores the raw `query`.

### `folder_list`
List folders/labels with IDs and message counts.
Params: `inbox_id?`, `inbox?`.

---

## send:email

### `email_send`
Params: `inbox_id?`, `inbox?`, `to` (required), `subject` (required), `body` (required), `cc?`, `bcc?`, `html_body?`, `reply_to?`, `attachments?`.

### `email_reply`
Threading headers set automatically.
Params: `inbox_id?`, `inbox?`, `message_id` (required), `body` (required), `html_body?`, `reply_all?`, `attachments?`.

### `email_forward`
Params: `inbox_id?`, `inbox?`, `message_id` (required), `to` (required), `cc?`, `bcc?`, `body?`, `html_body?`, `include_attachments?`.

### `email_archive`
Single-message state change (non-destructive) — moves the message out of the Inbox to the archive.
Params: `inbox_id?`, `inbox?`, `message_id` (required).

### `email_flag`
Apply a read/unread/flag/unflag action to one or more messages in one call. Use
`action` `read`/`unread` to change read status, or `flag`/`unflag` to add/remove
a star/follow-up flag. Pass one message ID or up to 500.
Params: `inbox_id?`, `inbox?`, `message_ids` (required, 1–500), `action` (required: `read` | `unread` | `flag` | `unflag`).

---

## manage:folders

Folder **destinations** (`destination_folder_id`) accept a **canonical alias**
(`inbox`, `sent`, `drafts`, `trash`, `archive`, `spam`), a folder/label **name**,
OR a provider-native ID — resolved automatically.

### `folder_create`
Params: `inbox_id?`, `inbox?`, `name` (required).

### `folder_rename`
Params: `inbox_id?`, `inbox?`, `folder_id` (required), `new_name` (required).

### `folder_delete`
Irreversible (messages inside may be lost). Flagged as destructive to the MCP
client, which handles confirmation.
Params: `inbox_id?`, `inbox?`, `folder_id` (required).

### `email_move`
Params: `inbox_id?`, `inbox?`, `message_id` (required), `destination_folder_id` (required).

### `email_move_batch`
Params: `inbox_id?`, `inbox?`, `message_ids` (required, ≤500), `destination_folder_id` (required).

### `email_search_and_move`
Search + move in one server-side op (avoids stale IDs, ≤500). Same structured
search fields as `email_search`.
Params: `inbox_id?`, `inbox?`, structured search fields (`from`, `to`, `cc`,
`subject`, `body`, `text`, `unread`, `has_attachment`, `flagged`, `since`,
`before`), `query?`, `destination_folder_id` (required), `include_folders?`, `limit?`.

---

## delete:email

Delete defaults to the provider's Trash; `permanent: true` hard-deletes
(expunge available on IMAP/Fastmail only; Gmail/Outlook trash-only). These
actions are **flagged as destructive** to the MCP client, which handles user
confirmation — there is **no `confirm` parameter**. Deletes remain
irreversible/permanent as described.

### `email_delete`
Params: `inbox_id?`, `inbox?`, `message_id` (required), `permanent?`.

### `email_delete_batch`
Params: `inbox_id?`, `inbox?`, `message_ids` (required, ≤500), `permanent?`.

### `email_search_and_delete`
Search + delete in one server-side op (≤500). Same structured search fields as `email_search`.
Params: `inbox_id?`, `inbox?`, structured search fields, `query?`, `permanent?`, `include_folders?`, `limit?`.

---

## manage:drafts

### `draft_list`
Params: `inbox_id?`, `inbox?`, `limit?`.

### `draft_create`
Params: `inbox_id?`, `inbox?`, `subject` (required), `body` (required), `to?`, `cc?`, `bcc?`, `html_body?`.

### `draft_update`
Params: `inbox_id?`, `inbox?`, `draft_id` (required), `subject` (required), `body` (required), `to?`, `cc?`, `bcc?`, `html_body?`.

### `draft_send`
Params: `inbox_id?`, `inbox?`, `draft_id` (required).

---

## manage:contacts

Contacts are derived automatically from message headers (From/To/Reply-To).

### `contact_search`
Params: `query` (required), `inbox_id?`, `inbox?`, `limit?`.

---

## schedule:email

### `schedule_create`
Dispatcher runs every minute, so delivery may be up to 60s after `send_at`.
Params: `inbox_id?`, `inbox?`, `to` (required), `subject` (required), `body` (required), `send_at` (required, ISO 8601), `cc?`, `bcc?`, `html_body?`, `attachments?`, `reply_to?`.

### `schedule_list`
Params: `inbox_id?`, `inbox?`, `limit?`.

### `schedule_cancel`
Params: `scheduled_send_id` (required, UUID).

---

## Errors & rate limits

- Auth/scope/rate failures → JSON-RPC `error` object (`-32001`, `-32601`,
  `-32602`, `-32029`). Tool-execution failures → result with `isError: true`.
- Rate limits: 100 req/min · 1,000/hr · 10,000/day per key. On `-32029`, honour
  `data.retry_after` (seconds) before retrying. Never blindly retry sends.

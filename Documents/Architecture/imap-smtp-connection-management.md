# IMAP/SMTP Connection Management

## Purpose

This document describes how MCPEmails connects to email providers at the protocol level — which transport each provider uses, how connections are established and authenticated, how the system manages connection lifetimes inside stateless Edge Functions, and how errors and rate limits are handled. It is the authoritative reference for anyone writing or reviewing email integration code.

---

## 1. Provider Protocol Selection

MCPEmails uses native APIs for Gmail and Outlook, and IMAP/SMTP for Fastmail and any generic provider. This is a deliberate decision, not a fallback.

| Provider | Read protocol | Write (send) protocol | Why |
|---|---|---|---|
| Gmail | Gmail REST API | Gmail REST API (`send`) | OAuth scopes gate access; the Gmail API supports labels, threads, batch, and push notifications natively. IMAP over XOAUTH2 works but is slower, does not expose labels as first-class objects, and requires managing TLS sockets inside Edge Functions. |
| Outlook / Microsoft 365 | Microsoft Graph REST API | Microsoft Graph (`sendMail`) | Same reasoning as Gmail. Graph API exposes categories, focused inbox, and delta-sync (`@odata.deltaLink`) which have no IMAP equivalent. |
| Fastmail | IMAP (993, TLS) | SMTP (465, TLS) | Fastmail has no public REST API. It has excellent IMAP compliance, IDLE support, and generous concurrent connection limits (20 per account). IMAP is the right tool here. |
| Generic / self-hosted | IMAP (user-supplied host + port) | SMTP (user-supplied host + port) | No alternative exists. |

**Decision rationale for Gmail and Outlook:** Every hour of production operation where Gmail or Outlook credentials are used via IMAP is an hour where the application manages raw TLS sockets in a V8 isolate with a 50ms CPU budget. The native APIs were specifically designed to avoid this. The only cases where IMAP would be reconsidered are: (a) a provider removes API access, or (b) a use case requires IMAP-only capabilities such as `APPEND` to a specific folder with custom flags. Neither applies to the current MCP tool set.

---

## 2. IMAP Connection Lifecycle

A single IMAP operation in MCPEmails follows this exact sequence. There is no persistent idle connection across requests; see Section 3.

```
1. Resolve host and port from inbox record
2. Open TLS socket (implicit TLS on port 993)
3. Read server greeting — verify "* OK" prefix
4. Authenticate via XOAUTH2 (OAuth providers) or PLAIN (app passwords)
5. SELECT target mailbox
6. Execute IMAP command (FETCH, SEARCH, STORE, etc.)
7. Read response until tagged OK/NO/BAD
8. LOGOUT and close socket
```

**Step 3 — Greeting validation.** If the greeting is not `* OK`, the connection is rejected immediately and the inbox `status` is set to `error` with `last_error = 'IMAP server did not send a valid greeting'`. This catches misconfigured hosts early.

**Step 5 — Mailbox selection.** `SELECT` is preferred over `EXAMINE` for all read operations because some servers behave differently under `EXAMINE` with respect to flag propagation. The one exception is when the operation is explicitly read-only and the inbox is shared — this does not apply in the current schema.

**Step 7 — Collecting the tagged response.** Every IMAP command receives a unique tag (e.g. `A0001`). The client reads lines until it sees a line beginning with that tag. Untagged responses (`*`) arriving before the tagged response are collected and processed (e.g. `* FETCH` data, `* EXISTS` count). The client does not assume a fixed number of response lines.

**Step 8 — LOGOUT on all paths.** The `LOGOUT` command is always issued — including on error paths — before closing the socket. This allows the server to cleanly account for the disconnected session. If `LOGOUT` itself fails, the socket is destroyed anyway.

---

## 3. Connection Pooling Strategy

**Why per-request connections.** Supabase Edge Functions run as Deno V8 isolates. Each isolate handles one request at a time and may be recycled between requests. There is no shared memory across requests and no guarantee that the same isolate handles two consecutive requests from the same user. A persistent IMAP connection cannot live across requests in this model.

**Consequence.** Every IMAP tool call performs a full connect-authenticate-select-operate-logout cycle. This adds approximately 200–400ms of latency compared to a warm connection (TLS handshake + AUTH round-trip + SELECT round-trip).

**Mitigation strategies in order of impact:**

1. **Batch within one request.** When an MCP tool invocation requires multiple IMAP commands against the same mailbox (e.g. `list_inbox` fetching headers for 25 messages), all FETCHes are issued as a sequence command range (`FETCH 1:25 (FLAGS ENVELOPE)`) before LOGOUT. One connection services the entire tool call.

2. **Prefer sequence sets over individual UIDs.** `FETCH 100,103,107 (RFC822.SIZE ENVELOPE)` in one command is dramatically faster than three separate FETCH commands. The IMAP client utility always collapses UID lists into sequence sets before sending.

3. **Minimise selected data.** `FETCH` requests only the fields needed. For list views: `(FLAGS ENVELOPE UID)`. For full message read: `(RFC822)`. Never `(RFC822)` when `(ENVELOPE)` suffices.

4. **TLS session resumption.** The Node.js / Deno TLS layer attempts session resumption by default. When the same Edge Function isolate handles a subsequent request to the same host within a short window, the TLS handshake is reduced to one round-trip instead of two. This is opportunistic and cannot be relied upon.

5. **Parallelise cross-mailbox calls.** If a single MCP tool call requires operations on multiple inboxes (e.g., `search_email` across all connected accounts), connections are opened in parallel with `Promise.all`, bounded to a maximum of 5 concurrent sockets per tool call to avoid hitting Fastmail's 20-connection limit.

---

## 4. XOAUTH2 Authentication for IMAP

Gmail and Outlook both support IMAP access via the `AUTH=XOAUTH2` SASL mechanism when OAuth scopes permit it. Fastmail supports XOAUTH2 but currently accepts app passwords; XOAUTH2 is the path for Fastmail when Fastmail's OAuth token includes IMAP access.

### XOAUTH2 Token Construction

The XOAUTH2 mechanism sends a single base64-encoded string in the `AUTHENTICATE XOAUTH2` command. The string before encoding has this structure:

```
user=<email>\x01auth=Bearer <access_token>\x01\x01
```

Where `\x01` is the ASCII SOH (Start of Heading) character (byte value 0x01).

TypeScript implementation:

```typescript
/**
 * Build the base64-encoded XOAUTH2 string required by IMAP AUTH=XOAUTH2.
 *
 * @param email - The full email address (e.g. "user@gmail.com")
 * @param accessToken - A valid, non-expired OAuth2 access token
 * @returns Base64-encoded XOAUTH2 payload, ready to send after "AUTHENTICATE XOAUTH2 "
 */
function buildXOAuth2Token(email: string, accessToken: string): string {
  // Structure: "user=<email>\x01auth=Bearer <token>\x01\x01"
  const raw = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`;
  return btoa(raw);
}
```

**Usage in the IMAP authenticate command:**

```typescript
// After receiving the server greeting:
// C: A0001 AUTHENTICATE XOAUTH2 <base64-payload>
// S: A0001 OK authenticated

async function authenticateXOAuth2(
  socket: TLSSocket,
  email: string,
  accessToken: string,
  tag: string
): Promise<void> {
  const payload = buildXOAuth2Token(email, accessToken);
  await socketWrite(socket, `${tag} AUTHENTICATE XOAUTH2 ${payload}\r\n`);

  const response = await readTaggedResponse(socket, tag);

  if (response.startsWith(`${tag} NO`) || response.startsWith(`${tag} BAD`)) {
    // The server may return a base64-encoded JSON error body as a challenge.
    // Decode it for logging, but never expose it to the client response.
    const challengeLine = response.match(/\+ (.+)/)?.[1];
    if (challengeLine) {
      const decoded = atob(challengeLine);
      // Log internally only — decoded contains error codes, not secrets
      console.error('[IMAP XOAUTH2] Auth challenge:', decoded);
    }
    throw new ImapAuthError('XOAUTH2 authentication rejected by server');
  }
}
```

**Token expiry.** Before opening any IMAP connection, the Edge Function checks whether the stored OAuth access token expires within the next 5 minutes. If so, it calls the provider's token endpoint to refresh it, updates the encrypted value in the `inboxes` table, and uses the fresh token. This check is performed in the same transaction as fetching the inbox credentials, not as a separate pre-flight call.

**XOAUTH2 error challenge.** When XOAUTH2 authentication fails, the IMAP server may send a `+` continuation challenge containing a base64-encoded JSON object with an error code (e.g. `{"status": "400", "schemes": "bearer", "scope": "..."}`). The client must respond with an empty line (`\r\n`) to complete the exchange before the server sends the tagged `NO` response. Failing to send the empty line leaves the connection in an undefined state.

---

## 5. Provider-Specific IMAP Settings

### Gmail

| Setting | Value |
|---|---|
| IMAP host | `imap.gmail.com` |
| IMAP port | `993` |
| TLS | Implicit (connect directly over TLS, no STARTTLS) |
| Authentication | XOAUTH2 only — no app password path in MCPEmails |
| Username | Full email address (`user@gmail.com`) |
| Special folders | `[Gmail]/Sent Mail`, `[Gmail]/Drafts`, `[Gmail]/Trash`, `[Gmail]/Spam`, `[Gmail]/All Mail` |

**Gmail IMAP is not the primary path.** The Gmail REST API is used for all Gmail operations (see Section 7). The IMAP connection code for Gmail exists as a fallback for edge cases not supported by the API, specifically appending a message to a non-standard label using `APPEND`.

**Folder naming.** Gmail maps its label system onto IMAP folders with localized names in some accounts. The `LIST ""  "*"` command is always issued to discover the actual folder names rather than assuming English names. `\Inbox`, `\Sent`, `\Drafts`, `\Trash` IMAP special-use attributes (RFC 6154) are used where available.

### Outlook / Microsoft 365

| Setting | Value |
|---|---|
| IMAP host | `outlook.office365.com` |
| IMAP port | `993` |
| TLS | Implicit |
| Authentication | XOAUTH2 (OAuth access token from Microsoft Identity Platform) |
| Username | Full email address |
| Special folders | `Inbox`, `Sent Items`, `Drafts`, `Deleted Items`, `Junk Email` |

**Outlook IMAP is not the primary path.** Microsoft Graph is used for all Outlook operations (see Section 8). The IMAP code for Outlook exists for the same narrow fallback reasons as Gmail — specifically `APPEND` to a non-standard folder.

**OAuth scope for IMAP.** Microsoft requires the scope `https://outlook.office.com/IMAP.AccessAsUser.All` in addition to `Mail.Read` and `Mail.Send` for IMAP access. This scope is not requested during the initial OAuth flow because it triggers additional consent and is not needed for Graph API access. If the fallback IMAP path is hit for an Outlook inbox that does not have this scope, the XOAUTH2 authentication will fail with a `400` error challenge; the error is caught and the operation is aborted with `AUTH_SCOPE_INSUFFICIENT`.

### Fastmail

| Setting | Value |
|---|---|
| IMAP host | `imap.fastmail.com` |
| IMAP port | `993` |
| TLS | Implicit |
| Authentication | PLAIN (app password) or XOAUTH2 (OAuth token) |
| Username | Full email address |
| Special folders | `INBOX`, `Sent`, `Drafts`, `Trash`, `Spam` |

Fastmail is the primary IMAP provider. All Fastmail operations use IMAP for reading and SMTP for sending. No REST API alternative exists.

**App password auth (PLAIN).** When a Fastmail inbox is connected using an app password rather than OAuth, the `AUTH PLAIN` mechanism is used. The PLAIN token is: `\x00<username>\x00<password>` (null-delimited), base64-encoded. This is sent over the TLS-encrypted socket and is safe despite "PLAIN" in the name.

```typescript
function buildPlainAuthToken(username: string, password: string): string {
  // Structure: \x00username\x00password
  const raw = `\x00${username}\x00${password}`;
  return btoa(raw);
}
```

**IMAP IDLE.** Fastmail supports RFC 2177 IDLE. MCPEmails does not use persistent IDLE connections (see Section 3), but the fact that Fastmail supports IDLE means delta-sync can be implemented in a future long-lived worker if the architecture moves off Edge Functions for Fastmail inbox monitoring.

---

## 6. SMTP for Sending

SMTP is used only for Fastmail and generic providers. Gmail and Outlook sending goes through their respective REST APIs.

### SMTP Connection Lifecycle

```
1. Open TLS socket to port 465 (implicit TLS) or connect to 587 with STARTTLS
2. Read server greeting (220)
3. Send EHLO <hostname>
4. Read capability list (includes AUTH PLAIN / AUTH XOAUTH2)
5. Authenticate (PLAIN or XOAUTH2)
6. MAIL FROM: <sender>
7. RCPT TO: <recipient> (one command per recipient)
8. DATA — send RFC 5322 message
9. QUIT
```

### Provider SMTP Settings

| Provider | Host | Port | TLS |
|---|---|---|---|
| Fastmail | `smtp.fastmail.com` | `465` | Implicit |
| Generic | User-supplied | User-supplied | Per setting |

Port 587 with STARTTLS is supported by Fastmail but MCPEmails defaults to 465 (implicit TLS) for Fastmail because it eliminates the STARTTLS negotiation round-trip and avoids STARTTLS downgrade attacks. For generic providers, the user's configured port and TLS mode are used as-is.

### MIME Message Construction

Outbound messages are constructed as RFC 5322 MIME messages before passing to the SMTP `DATA` command. The structure for the common case (text + optional HTML + optional attachments):

```typescript
interface OutboundMessage {
  from: string;          // "Display Name <email@example.com>"
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  attachments?: Array<{
    filename: string;
    contentType: string;
    data: Uint8Array;
  }>;
  inReplyTo?: string;    // Message-ID of the email being replied to
  references?: string[]; // Full references chain for threading
}

function buildMimeMessage(msg: OutboundMessage): string {
  const boundary = `mcpe_${crypto.randomUUID().replace(/-/g, '')}`;
  const lines: string[] = [];

  // Headers
  lines.push(`From: ${msg.from}`);
  lines.push(`To: ${msg.to.join(', ')}`);
  if (msg.cc?.length) lines.push(`Cc: ${msg.cc.join(', ')}`);
  // BCC recipients are passed to RCPT TO but not included in headers
  lines.push(`Subject: ${encodeMimeHeader(msg.subject)}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`Message-ID: <${crypto.randomUUID()}@mcpemails.com>`);
  if (msg.inReplyTo) lines.push(`In-Reply-To: ${msg.inReplyTo}`);
  if (msg.references?.length) lines.push(`References: ${msg.references.join(' ')}`);
  lines.push(`MIME-Version: 1.0`);

  const hasAlternative = !!msg.htmlBody;
  const hasAttachments = !!msg.attachments?.length;

  if (!hasAlternative && !hasAttachments) {
    // Simple plain-text message
    lines.push(`Content-Type: text/plain; charset=UTF-8`);
    lines.push(`Content-Transfer-Encoding: quoted-printable`);
    lines.push('');
    lines.push(encodeQuotedPrintable(msg.textBody));
  } else if (hasAlternative && !hasAttachments) {
    // Multipart/alternative: text + HTML
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: text/plain; charset=UTF-8`);
    lines.push(`Content-Transfer-Encoding: quoted-printable`);
    lines.push('');
    lines.push(encodeQuotedPrintable(msg.textBody));
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: text/html; charset=UTF-8`);
    lines.push(`Content-Transfer-Encoding: quoted-printable`);
    lines.push('');
    lines.push(encodeQuotedPrintable(msg.htmlBody!));
    lines.push(`--${boundary}--`);
  } else {
    // Multipart/mixed for attachments
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push('');
    // Body part (possibly multipart/alternative itself)
    lines.push(`--${boundary}`);
    // ... (nested alternative if htmlBody present, otherwise plain text)
    for (const att of msg.attachments ?? []) {
      lines.push(`--${boundary}`);
      lines.push(`Content-Type: ${att.contentType}; name="${encodeMimeHeader(att.filename)}"`);
      lines.push(`Content-Disposition: attachment; filename="${encodeMimeHeader(att.filename)}"`);
      lines.push(`Content-Transfer-Encoding: base64`);
      lines.push('');
      lines.push(encodeBase64Chunked(att.data));
    }
    lines.push(`--${boundary}--`);
  }

  return lines.join('\r\n');
}
```

**Dot-stuffing.** The SMTP `DATA` command requires that any line beginning with `.` has an additional `.` prepended (RFC 5321 §4.5.2). The SMTP send utility applies dot-stuffing to the entire message body before writing it to the socket.

**BCC handling.** BCC recipients are included in the `RCPT TO` commands but deliberately omitted from the `Bcc:` header in the message body. This is correct per RFC 5321 and prevents BCC addresses from being visible to To/Cc recipients.

---

## 7. Gmail API — When and Why

The Gmail REST API is the primary email transport for all Gmail inboxes. IMAP is not used for Gmail in the normal operation of any MCP tool.

### Capabilities That Make Gmail API Preferable

| Capability | Gmail API | IMAP |
|---|---|---|
| Label management | Native; labels are first-class objects | Simulated via folder hierarchy; limited |
| Thread model | Native `threadId` on every message | Manual reconstruction via `References` header |
| Batch requests | Up to 100 operations in one HTTP request | Not supported |
| Push notifications | Pub/Sub webhook for new mail | IDLE (requires persistent connection) |
| Message format | JSON with pre-parsed headers | Raw RFC 5322 bytes requiring parsing |
| Attachment handling | Separate `attachmentId` endpoint, streamed | Inline in FETCH response, loaded into memory |

### Gmail API Usage Patterns in MCPEmails

**`list_inbox` tool:** Calls `users.messages.list` with `maxResults`, then a batched `users.messages.get?format=metadata&metadataHeaders=From,To,Subject,Date` for the message list. Two HTTP calls total regardless of page size.

**`read_email` tool:** Calls `users.messages.get?format=full` for the specific message ID. The API returns already-decoded header values and body parts; no RFC 5322 parsing is needed.

**`search_email` tool:** Passes the MCP `query` parameter directly as the `q` parameter to `users.messages.list`. Gmail's search syntax (`from:`, `to:`, `subject:`, `after:`, `before:`, `has:attachment`) is exposed directly — the MCP layer documents the supported syntax.

**`send_email` tool:** Constructs a MIME message (same `buildMimeMessage` utility used for SMTP), base64url-encodes it, and calls `users.messages.send`. The Gmail API handles SMTP delivery internally.

**`reply_to_email` tool:** Fetches the original message to get `threadId`, `Message-ID`, and `References`. Constructs the reply with appropriate headers (`In-Reply-To`, `References`) and calls `users.messages.send` with `threadId` set.

### Authentication

The Gmail API is called with an `Authorization: Bearer <access_token>` header. The same token refresh logic (5-minute pre-expiry check) applies here as in the XOAUTH2 IMAP path. The difference is that the access token is passed in an HTTP header rather than encoded into a SASL token.

---

## 8. Microsoft Graph API — When and Why

Microsoft Graph (`https://graph.microsoft.com/v1.0/me/messages`) is the primary transport for all Outlook/Microsoft 365 inboxes. IMAP is not used for Outlook in normal operation.

### Capabilities That Make Graph API Preferable

| Capability | Microsoft Graph | IMAP |
|---|---|---|
| Delta sync | `@odata.deltaLink` returns only changed items since last sync | Full FETCH required; custom state tracking needed |
| Throttle guidance | `Retry-After` header with exact seconds to wait | No standard mechanism |
| Categories | Native category objects | Not exposed via IMAP |
| Focused Inbox | `inferenceClassification` property | Not exposed via IMAP |
| Batch requests | `$batch` endpoint (up to 20 requests) | Not supported |
| Webhook notifications | Change notifications via `subscriptions` endpoint | IDLE (requires persistent connection) |

### Graph API Usage Patterns in MCPEmails

**`list_inbox` tool:** `GET /me/messages?$select=id,subject,from,receivedDateTime,isRead,hasAttachments&$top=25&$orderby=receivedDateTime desc`. The `$select` projection keeps response size small and avoids fetching body content unnecessarily.

**`read_email` tool:** `GET /me/messages/{id}?$select=id,subject,from,toRecipients,ccRecipients,body,receivedDateTime,attachments`. The Graph API returns body content as HTML or text according to the `body.contentType` field, with no additional decoding needed.

**`search_email` tool:** `GET /me/messages?$search="<query>"` using Graph's KQL search. Alternatively, `$filter` with OData expressions for structured queries (e.g. `from/emailAddress/address eq 'sender@example.com'`). The MCP tool documents which query syntax is supported.

**`send_email` tool:** `POST /me/sendMail` with a JSON body containing the message structure. No MIME construction needed — Graph accepts structured JSON.

**`reply_to_email` tool:** `POST /me/messages/{id}/reply` or `POST /me/messages/{id}/createReply` followed by `POST /me/messages/{replyDraftId}/send`. Using `createReply` first allows the reply draft to be inspected before sending.

### Throttling and Back-off

The Graph API returns `429 Too Many Requests` with a `Retry-After` header when throttled. The `Retry-After` value is always respected exactly — no guessing or fixed-delay back-off. If `Retry-After` is absent, the default wait is 60 seconds. After 5 consecutive `429` responses on the same tool call, the call fails with `PROVIDER_RATE_LIMITED` and the inbox `status` remains `active` (transient condition, not a configuration error).

```typescript
async function callGraphWithRetry<T>(
  fn: () => Promise<Response>,
  maxRetries = 5
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fn();

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('Retry-After') ?? '60', 10);
      await sleep(retryAfter * 1000);
      continue;
    }

    if (!response.ok) {
      throw await mapGraphError(response);
    }

    return response.json() as Promise<T>;
  }

  throw new McpEmailsError('PROVIDER_RATE_LIMITED', 'Microsoft Graph rate limit exceeded');
}
```

---

## 9. Error Handling

Every error that occurs during an IMAP, SMTP, or API operation is mapped to a typed error code before propagating to the MCP tool response layer. The mapping ensures that the AI agent (MCP client) receives a consistent, actionable error signal, and that the dashboard shows a human-readable message without exposing provider internals.

### Error Classification

```typescript
type EmailErrorCode =
  | 'CONNECTION_REFUSED'       // Socket connect failed — host unreachable or port blocked
  | 'TLS_HANDSHAKE_FAILED'     // TLS negotiation failed — cert invalid, SNI mismatch
  | 'AUTH_FAILED'              // Wrong credentials or revoked token
  | 'AUTH_TOKEN_EXPIRED'       // Access token expired and refresh failed
  | 'AUTH_SCOPE_INSUFFICIENT'  // Token lacks required OAuth scope
  | 'MAILBOX_NOT_FOUND'        // SELECT failed — folder does not exist
  | 'MESSAGE_NOT_FOUND'        // UID not found in mailbox
  | 'IMAP_NO_RESPONSE'         // Server returned NO to a command
  | 'IMAP_BAD_RESPONSE'        // Server returned BAD (malformed command)
  | 'IMAP_PROTOCOL_ERROR'      // Unexpected server response format
  | 'SMTP_RELAY_REJECTED'      // Server refused MAIL FROM or RCPT TO
  | 'SMTP_QUOTA_EXCEEDED'      // Sending quota exceeded (provider-level)
  | 'PROVIDER_RATE_LIMITED'    // 429 from Gmail API or Graph API
  | 'PROVIDER_SERVER_ERROR'    // 5xx from Gmail API or Graph API
  | 'CONNECTION_TIMEOUT'       // Socket or API call exceeded timeout budget
  | 'MESSAGE_TOO_LARGE'        // Message exceeds MCPEmails 10 MB limit
  | 'INBOX_INACTIVE';          // Inbox status is not 'active' (config issue, not transient)
```

### Error Mapping Table

| Condition | Error code | User-facing message | Inbox status update |
|---|---|---|---|
| TCP connect refused (ECONNREFUSED) | `CONNECTION_REFUSED` | "Cannot reach the mail server. Check that the host and port are correct." | Set to `error` |
| TCP connect timeout (ETIMEDOUT) | `CONNECTION_TIMEOUT` | "The mail server did not respond in time. It may be temporarily unavailable." | No change (transient) |
| TLS certificate error | `TLS_HANDSHAKE_FAILED` | "Could not establish a secure connection to the mail server." | Set to `error` |
| IMAP greeting is not `* OK` | `IMAP_PROTOCOL_ERROR` | "The server responded unexpectedly. Contact support." | Set to `error` |
| AUTHENTICATE → tagged `NO` | `AUTH_FAILED` | "Authentication failed. Re-connect your inbox to grant fresh credentials." | Set to `error` |
| Access token refresh returns 400 `invalid_grant` | `AUTH_TOKEN_EXPIRED` | "Your email credentials have expired. Re-connect your inbox." | Set to `error` |
| Microsoft XOAUTH2 scope error in challenge | `AUTH_SCOPE_INSUFFICIENT` | "Insufficient permissions. Re-connect your inbox and grant all requested scopes." | Set to `error` |
| SELECT → `NO [NONEXISTENT]` | `MAILBOX_NOT_FOUND` | "Folder not found. It may have been renamed or deleted." | No change |
| FETCH of unknown UID → empty response | `MESSAGE_NOT_FOUND` | "Email not found. It may have been deleted or moved." | No change |
| IMAP tagged `BAD` | `IMAP_BAD_RESPONSE` | "An internal error occurred. Please try again." | No change (logged) |
| SMTP 550/551 relay rejected | `SMTP_RELAY_REJECTED` | "The mail server refused to send this email. Check the recipient address." | No change |
| SMTP 552 over quota | `SMTP_QUOTA_EXCEEDED` | "Your email account has exceeded its sending quota." | No change |
| Gmail/Graph 429 (after retries) | `PROVIDER_RATE_LIMITED` | "The email provider is temporarily throttling requests. Try again in a few minutes." | No change |
| Gmail/Graph 5xx | `PROVIDER_SERVER_ERROR` | "The email provider is experiencing issues. Try again later." | No change |

**Error detail hygiene.** The `last_error` column on `inboxes` is populated with the error code and a human-readable message. It never contains: OAuth tokens, IMAP server challenge responses, raw SMTP banners, or stack traces. Internal error detail is written only to the function log (Supabase Edge Function log), which is not user-accessible.

**IMAP NO vs BAD.** A `NO` response means the server understood the command but declined it (e.g. mailbox locked, no permission, message not found). A `BAD` response means the server considers the command malformed. In practice, `BAD` from a correctly-implemented client indicates a bug in the IMAP command builder. Both are caught and mapped, but `BAD` triggers a Sentry alert because it should not occur in normal operation.

### Timeout Budget

Each Edge Function invocation has a maximum wall-clock time of 10 seconds (Supabase Edge Function default). Within that budget, connection timeouts are set as follows:

| Phase | Timeout |
|---|---|
| TCP connect | 5 seconds |
| TLS handshake | 5 seconds |
| IMAP authenticate | 5 seconds |
| IMAP SELECT | 3 seconds |
| IMAP command (FETCH, SEARCH, etc.) | 8 seconds |
| SMTP DATA accepted | 8 seconds |
| Gmail / Graph HTTP call | 8 seconds |

If any phase timeout fires, the socket is destroyed immediately and the operation returns `CONNECTION_TIMEOUT`. These values are conservative relative to normal server response times (< 500ms for IMAP SELECT on Fastmail, < 200ms for Gmail API) — they exist to prevent a slow server from consuming the entire Edge Function invocation.

---

## 10. Rate Limit Awareness

### Fastmail IMAP Connection Limits

Fastmail enforces a hard limit of **20 concurrent IMAP connections per account**. Edge Functions are short-lived, so under normal load (one MCP tool call at a time per inbox), this limit is never approached. The concern arises when an AI agent runs many parallel tool calls against the same Fastmail inbox — e.g., a loop issuing `search_email` followed by `read_email` for each result.

**Mitigation:**

1. MCPEmails enforces a global rate limit of 100 API calls per minute per API key (application layer, documented in `rate-limits.md`). This naturally caps concurrent Fastmail connections from a single key.

2. If a Fastmail connect attempt fails with an error matching `connection limit` or `too many connections`, the Edge Function retries with exponential back-off starting at 5 seconds:

```typescript
async function connectImapWithRetry(config: ImapConfig, maxRetries = 3): Promise<ImapSession> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await openImapSession(config);
    } catch (err) {
      const isConnectionLimit =
        err instanceof ImapNoError &&
        (err.message.includes('connection limit') ||
         err.message.includes('too many connections') ||
         err.message.includes('[LIMIT]'));

      if (isConnectionLimit && attempt < maxRetries) {
        const waitMs = 5000 * Math.pow(2, attempt - 1); // 5s, 10s, 20s
        await sleep(waitMs);
        continue;
      }

      throw err;
    }
  }
  throw new McpEmailsError('CONNECTION_REFUSED', 'IMAP connection limit reached');
}
```

3. The `activity_log` table is queried at the start of each Fastmail IMAP tool call to count connections opened in the past 30 seconds for the same inbox. If the count exceeds 15, the call is rejected with `PROVIDER_RATE_LIMITED` before even attempting to connect. This is an application-layer safety valve.

### Gmail API Quotas

Gmail API operates under two quota dimensions:

| Quota | Limit | Enforcement |
|---|---|---|
| Per-user per second | 250 requests/second (effective; Google's quota is 500/user/second but MCPEmails self-limits) | Application layer |
| Per-project per day | 5 billion quota units | Google Cloud Console |

Most read operations cost 5 quota units; `messages.get` costs 5 units; `messages.send` costs 100 units. The daily project quota is not a practical concern at current scale.

The per-user rate limit is handled by catching `429` responses and applying exponential back-off with jitter:

```typescript
async function callGmailWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 5
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isGmailRateLimitError(err) && attempt < maxRetries - 1) {
        // Exponential back-off with full jitter: random(0, 2^attempt * 1000ms)
        const ceiling = Math.min(1000 * Math.pow(2, attempt), 30_000);
        const waitMs = Math.random() * ceiling;
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
  throw new McpEmailsError('PROVIDER_RATE_LIMITED', 'Gmail API rate limit exceeded');
}
```

**Jitter rationale.** Multiple concurrent tool calls for the same Gmail account hitting the rate limit simultaneously would, without jitter, retry at the same moment — causing a retry storm. Full jitter distributes retry times uniformly across the back-off window, reducing the probability of synchronized retries.

### Microsoft Graph Throttling

Graph API throttling is per-user, per-application. The key difference from Gmail is that Graph provides explicit back-off guidance via the `Retry-After` response header. This value is always used directly (see Section 8). Jitter is not applied to Graph retries because the `Retry-After` value already accounts for server-side load distribution.

MCPEmails also reads `X-RateLimit-Remaining` when present and preemptively adds a 200ms delay between Graph requests when remaining capacity drops below 10% of the limit. This reduces the chance of hitting `429` in the first place.

### MCPEmails Application-Layer Rate Limits

These limits are enforced by the Edge Function before any provider call is made:

| Limit | Value | Enforcement point |
|---|---|---|
| API key calls | 100 / minute | `activity_log` count, last 60 seconds |
| API key calls | 1,000 / hour | `activity_log` count, last 3,600 seconds |
| API key calls | 10,000 / day | `activity_log` count, last 86,400 seconds |
| Message size (send) | 10 MB | MCP tool input validation |
| Attachment count | 20 per email | MCP tool input validation |
| Search results | 100 maximum | Tool output cap |

When any of these limits is exceeded, the tool call returns a `429` response with a `Retry-After` header set to the number of seconds until the rate limit window resets. The AI agent is expected to honour this value.

---

## IMAP Connection Utility — Complete TypeScript Pseudocode

The following is a representative TypeScript implementation of the core IMAP connection utility. In practice this wraps a Deno-compatible TLS socket library; the exact socket API differs from Node.js but the logic is identical.

```typescript
import { TLSSocket, connect as tlsConnect } from 'tls'; // or Deno equivalent

// ── Types ────────────────────────────────────────────────────────────────────

interface ImapConfig {
  host: string;
  port: number;
  email: string;
  authMethod: 'XOAUTH2' | 'PLAIN';
  // Exactly one of these is set, depending on authMethod:
  accessToken?: string;
  appPassword?: string;
}

interface ImapSession {
  fetch(mailbox: string, uidSet: string, items: string): Promise<ImapMessage[]>;
  search(mailbox: string, criteria: string): Promise<number[]>;
  store(mailbox: string, uidSet: string, flags: string): Promise<void>;
  logout(): Promise<void>;
}

interface ImapMessage {
  uid: number;
  flags: string[];
  envelope?: Record<string, string>;
  body?: string;
}

class ImapAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImapAuthError';
  }
}

class ImapNoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImapNoError';
  }
}

// ── XOAUTH2 token construction ────────────────────────────────────────────────

function buildXOAuth2Token(email: string, accessToken: string): string {
  const raw = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`;
  return btoa(raw);
}

function buildPlainAuthToken(username: string, password: string): string {
  const raw = `\x00${username}\x00${password}`;
  return btoa(raw);
}

// ── Low-level socket helpers ──────────────────────────────────────────────────

let tagCounter = 0;

function nextTag(): string {
  tagCounter = (tagCounter + 1) % 10000;
  return `A${String(tagCounter).padStart(4, '0')}`;
}

async function readLine(socket: TLSSocket): Promise<string> {
  // Buffer reads until \r\n; implementation depends on socket library
  return readUntilCRLF(socket);
}

async function readTaggedResponse(socket: TLSSocket, tag: string): Promise<{
  status: 'OK' | 'NO' | 'BAD';
  text: string;
  untagged: string[];
}> {
  const untagged: string[] = [];

  while (true) {
    const line = await readLine(socket);

    if (line.startsWith(`${tag} OK`)) {
      return { status: 'OK', text: line.slice(tag.length + 4), untagged };
    }
    if (line.startsWith(`${tag} NO`)) {
      return { status: 'NO', text: line.slice(tag.length + 4), untagged };
    }
    if (line.startsWith(`${tag} BAD`)) {
      return { status: 'BAD', text: line.slice(tag.length + 5), untagged };
    }

    // Untagged response (continuation data)
    if (line.startsWith('* ') || line.startsWith('+ ')) {
      untagged.push(line);
    }
  }
}

// ── Session establishment ─────────────────────────────────────────────────────

export async function openImapSession(config: ImapConfig): Promise<ImapSession> {
  // 1. Open TLS socket (implicit TLS on port 993)
  const socket = await Promise.race([
    tlsConnect({ host: config.host, port: config.port }),
    sleep(5000).then(() => { throw new McpEmailsError('CONNECTION_TIMEOUT', 'TLS connect timed out'); }),
  ]);

  // 2. Read and validate server greeting
  const greeting = await readLine(socket);
  if (!greeting.startsWith('* OK')) {
    socket.destroy();
    throw new McpEmailsError('IMAP_PROTOCOL_ERROR', `Unexpected greeting: ${greeting.slice(0, 80)}`);
  }

  // 3. Authenticate
  const authTag = nextTag();
  if (config.authMethod === 'XOAUTH2') {
    const payload = buildXOAuth2Token(config.email, config.accessToken!);
    socket.write(`${authTag} AUTHENTICATE XOAUTH2 ${payload}\r\n`);

    const authResult = await readTaggedResponse(socket, authTag);

    if (authResult.status !== 'OK') {
      // Handle XOAUTH2 error challenge: server may send "+ <base64>" before tagged NO
      const challenge = authResult.untagged.find(l => l.startsWith('+ '));
      if (challenge) {
        // Respond with empty string to complete the exchange
        socket.write('\r\n');
        await readTaggedResponse(socket, authTag);
        // Log decoded challenge for debugging (no secrets exposed)
        const decoded = atob(challenge.slice(2));
        console.error('[IMAP XOAUTH2 challenge]', decoded);
      }
      socket.destroy();
      throw new ImapAuthError(`XOAUTH2 auth failed: ${authResult.text}`);
    }
  } else {
    // AUTH PLAIN
    const payload = buildPlainAuthToken(config.email, config.appPassword!);
    socket.write(`${authTag} AUTHENTICATE PLAIN ${payload}\r\n`);

    const authResult = await readTaggedResponse(socket, authTag);
    if (authResult.status !== 'OK') {
      socket.destroy();
      throw new ImapAuthError(`PLAIN auth failed: ${authResult.text}`);
    }
  }

  // 4. Return session object with high-level methods
  return {
    async fetch(mailbox: string, uidSet: string, items: string): Promise<ImapMessage[]> {
      // SELECT mailbox
      const selectTag = nextTag();
      socket.write(`${selectTag} SELECT "${mailbox}"\r\n`);
      const selectResult = await readTaggedResponse(socket, selectTag);
      if (selectResult.status === 'NO') {
        throw new ImapNoError(`SELECT failed: ${selectResult.text}`);
      }

      // UID FETCH
      const fetchTag = nextTag();
      socket.write(`${fetchTag} UID FETCH ${uidSet} ${items}\r\n`);
      const fetchResult = await readTaggedResponse(socket, fetchTag);
      return parseFetchResponse(fetchResult.untagged);
    },

    async search(mailbox: string, criteria: string): Promise<number[]> {
      const selectTag = nextTag();
      socket.write(`${selectTag} SELECT "${mailbox}"\r\n`);
      await readTaggedResponse(socket, selectTag);

      const searchTag = nextTag();
      socket.write(`${searchTag} UID SEARCH ${criteria}\r\n`);
      const result = await readTaggedResponse(socket, searchTag);
      const searchLine = result.untagged.find(l => l.startsWith('* SEARCH'));
      if (!searchLine) return [];
      return searchLine.slice(9).split(' ').filter(Boolean).map(Number);
    },

    async store(mailbox: string, uidSet: string, flags: string): Promise<void> {
      const selectTag = nextTag();
      socket.write(`${selectTag} SELECT "${mailbox}"\r\n`);
      await readTaggedResponse(socket, selectTag);

      const storeTag = nextTag();
      socket.write(`${storeTag} UID STORE ${uidSet} ${flags}\r\n`);
      await readTaggedResponse(socket, storeTag);
    },

    async logout(): Promise<void> {
      const logoutTag = nextTag();
      socket.write(`${logoutTag} LOGOUT\r\n`);
      try {
        await readTaggedResponse(socket, logoutTag);
      } finally {
        socket.destroy();
      }
    },
  };
}
```

---

## Integration Points

- **Token refresh**: The Edge Function that runs each MCP tool call reads the `oauth_token_expires_at` column from `inboxes` and refreshes before connecting if within 5 minutes of expiry. Refresh logic is in `supabase/functions/_shared/token-refresh.ts`.
- **Credential decryption**: Encrypted `oauth_access_token` and `imap_password` are decrypted in the Edge Function using the Vault key before being passed to `openImapSession` or `buildXOAuth2Token`. The decrypted values are never written to logs or stored anywhere except in-memory for the duration of the request.
- **Activity logging**: Every connection attempt (success or failure) writes a row to `activity_log` with the `tool_name`, `status`, `duration_ms`, and `error_code`. This is the data source for the dashboard activity feed and for rate-limit enforcement.
- **Inbox status updates**: `AUTH_FAILED`, `CONNECTION_REFUSED`, `TLS_HANDSHAKE_FAILED`, and `AUTH_TOKEN_EXPIRED` errors update `inboxes.status` to `error` and populate `inboxes.last_error`. All other errors are transient and do not change inbox status.

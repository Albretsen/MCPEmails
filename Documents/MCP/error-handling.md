# MCP Error Handling

## Error Response Format

All errors follow this format:

```json
{
  "error": {
    "code": "error_code",
    "message": "Human-readable message",
    "details": {
      "field": "specific details"
    }
  }
}
```

## Error Codes

### Authentication Errors (4xx)

**invalid_token**
- Status: 401
- Cause: API key is invalid, expired, or has been revoked
- Solution: Generate a new API key or refresh OAuth token

**insufficient_scope**
- Status: 403
- Cause: API key doesn't have permission for this tool
- Solution: Use a key with the required scope

**workspace_not_found**
- Status: 404
- Cause: Workspace doesn't exist or user doesn't have access
- Solution: Verify workspace ID

### Resource Errors (4xx)

**inbox_not_found**
- Status: 404
- Cause: Email inbox doesn't exist or isn't connected
- Solution: Check inbox ID; reconnect if needed

**message_not_found**
- Status: 404
- Cause: Email message doesn't exist
- Solution: Message may have been deleted

**invalid_recipient**
- Status: 400
- Cause: Recipient email address is invalid
- Solution: Verify email format

### Rate Limit Errors (429)

**rate_limit_exceeded**
- Status: 429
- Cause: API call limit exceeded
- Solution: Use exponential backoff; wait `retry_after` seconds

**quota_exceeded**
- Status: 429
- Cause: User account hit daily limit (e.g., can't send more emails today)
- Solution: Wait until next day or upgrade plan

### Provider Errors (5xx)

**auth_failed**
- Status: 500
- Cause: Provider (Gmail, Outlook, etc.) rejected authentication
- Solution: User may need to re-authenticate; token may have been revoked

**provider_error**
- Status: 500
- Cause: Provider API returned an error (service degradation, etc.)
- Solution: Retry with exponential backoff; may be temporary

**provider_unavailable**
- Status: 503
- Cause: Provider service is down
- Solution: Retry later (usually resolves within minutes)

### Validation Errors (400)

**invalid_request**
- Status: 400
- Cause: Request format is invalid (missing required field, wrong type, etc.)
- Solution: Check request format against tool documentation

**invalid_query**
- Status: 400
- Cause: Search query syntax is invalid
- Solution: Review search syntax documentation

## Retry Strategy

### Exponential Backoff

```javascript
async function callWithRetry(tool, params, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await callTool(tool, params);
    } catch (error) {
      if (error.code === 'rate_limit_exceeded') {
        const delay = error.retry_after * 1000 * Math.pow(2, attempt - 1);
        await sleep(delay);
        continue;
      }
      
      if (isRetryableError(error)) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000); // Cap at 30s
        await sleep(delay);
        continue;
      }
      
      throw error; // Not retryable
    }
  }
  throw new Error('Max retries exceeded');
}

function isRetryableError(error) {
  return ['provider_error', 'provider_unavailable', 'auth_failed'].includes(error.code);
}
```

### Non-Retryable Errors

These errors should fail immediately; don't retry:
- `invalid_token`
- `insufficient_scope`
- `invalid_request`
- `invalid_recipient`
- `inbox_not_found`
- `message_not_found`

## Client-Side Error Handling

### Show User-Friendly Messages

```javascript
const errorMessages = {
  invalid_token: 'Your authentication expired. Please sign in again.',
  insufficient_scope: 'This action requires additional permissions.',
  inbox_not_found: 'Inbox not found. It may have been disconnected.',
  provider_unavailable: 'Email service is temporarily unavailable. Please try again in a few minutes.',
  rate_limit_exceeded: 'Too many requests. Please wait a moment and try again.',
};

function getUserMessage(errorCode) {
  return errorMessages[errorCode] || 'An error occurred. Please try again.';
}
```

### Log for Debugging

```javascript
console.error('MCP Error', {
  code: error.code,
  message: error.message,
  tool: toolName,
  timestamp: new Date().toISOString(),
  // Don't log parameters if they contain secrets
});
```

## Common Scenarios

### Token Refresh

When you get `invalid_token`:

```javascript
try {
  return await callTool('list_inbox', { account: 'work-gmail' });
} catch (error) {
  if (error.code === 'invalid_token') {
    await refreshToken();
    return await callTool('list_inbox', { account: 'work-gmail' });
  }
  throw error;
}
```

### Graceful Degradation

If email service is down, show cached data:

```javascript
try {
  const emails = await fetchEmails();
  return emails;
} catch (error) {
  if (error.code === 'provider_unavailable') {
    return getCachedEmails();
  }
  throw error;
}
```

### User Re-authentication

If provider revoked access, prompt user to reconnect:

```javascript
if (error.code === 'auth_failed') {
  showModal({
    title: 'Reconnect Email',
    message: 'Please reconnect your email account.',
    action: () => navigate('/inboxes/connect'),
  });
}
```

---

**Note**: This is a placeholder. More detailed error scenarios and recovery examples should be added.

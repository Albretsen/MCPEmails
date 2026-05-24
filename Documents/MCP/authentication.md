# MCP Authentication & Security

## API Keys

### Creating API Keys

Users can create multiple API keys in the Dashboard under "API keys". Each key:
- Has a unique identifier
- Can be scoped to specific permissions
- Has an optional expiration date
- Shows last used timestamp
- Can be revoked at any time

### Using API Keys

Include the API key in the Authorization header:

```bash
curl -H "Authorization: Bearer mcpe_live_a3f8b2c9d1e7f4a6b8c2d4e6f1a3b5c7" \
  https://mcpemails.com/v1/tools
```

### Key Rotation

- Generate new key
- Update client to use new key
- Wait 24 hours (for cached credentials)
- Revoke old key

## OAuth Flows

### Gmail OAuth

1. User clicks "Connect Gmail"
2. Redirected to Google OAuth consent screen
3. User grants permission (read emails, send emails, etc.)
4. MCPEmails receives authorization code
5. Code exchanged for access token + refresh token
6. Tokens stored encrypted in database

**Token Lifetime**:
- Access token: 1 hour
- Refresh token: ~6 months (until user revokes)

**Refresh Logic**:
- Before each API call, check token expiration
- If expiring soon, refresh automatically
- If refresh fails (user revoked), show error to user

### Outlook OAuth

Similar to Gmail but via Microsoft Identity Platform.

**Token Lifetime**:
- Access token: 1 hour
- Refresh token: ~6 months

### Fastmail/IMAP

Fastmail provides app-specific passwords instead of OAuth. The user generates a password in Fastmail settings, which is stored encrypted.

No token refresh needed; credentials don't expire.

## Security Best Practices

### Never Log Credentials

- API keys should never appear in logs
- OAuth tokens should never appear in logs
- If you must debug, redact tokens (show first 5 and last 5 chars only)

### Encryption at Rest

All credentials are encrypted using Supabase's encryption feature:
- Database field: `encrypted_password` or `encrypted_token`
- Encryption key: Supabase project key (rotates automatically)

### Rate Limiting by Key

Each API key has independent rate limits:
- 100 calls/minute
- 1000 calls/hour
- 10,000 calls/day

Limits apply per key, not per user. A user with multiple keys has multiple limits.

### Audit Logging

Every MCP tool call is logged:
- Timestamp
- User/API key
- Tool name
- Parameters (but not secrets)
- Result (success/error)
- Response time

Users can view their activity log in Dashboard > Security.

## Error Handling

### Invalid Token

```json
{
  "error": "invalid_token",
  "message": "Token has expired or been revoked"
}
```

**Solution**: Refresh the token (OAuth) or create a new API key

### Insufficient Scope

```json
{
  "error": "insufficient_scope",
  "required": ["send:email"],
  "current": ["read:email"]
}
```

**Solution**: Use a key with the required scope or regenerate with more permissions

### Rate Limit

```json
{
  "error": "rate_limit_exceeded",
  "limit": 100,
  "window": "1 minute",
  "retry_after": 30
}
```

**Solution**: Wait 30 seconds and retry using exponential backoff

---

**Note**: This is a placeholder. Detailed OAuth flow diagrams and token refresh examples should be added.

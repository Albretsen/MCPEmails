# Email Provider OAuth Flows

## Gmail OAuth Flow

### Overview

Gmail uses Google OAuth 2.0. MCPEmails acts as a "confidential client" requesting access to user emails.

### Scopes Needed

- `https://www.googleapis.com/auth/gmail.readonly` — Read emails
- `https://www.googleapis.com/auth/gmail.send` — Send emails
- `https://www.googleapis.com/auth/gmail.modify` — Modify labels, move emails

### Flow Steps

1. **User clicks "Connect Gmail"** in MCPEmails dashboard
2. **Redirect to Google** with client ID, scopes, and callback URL
3. **User signs in** to Google account (if needed) and grants permission
4. **Google redirects** back to MCPEmails with authorization code
5. **Backend exchanges code** for access token + refresh token
6. **Tokens stored** encrypted in database
7. **User sees inbox** connected and ready to use

### Token Lifetime

- **Access token**: 1 hour
- **Refresh token**: ~6 months (until user revokes access or changes password)

### Refresh Logic

Before each API call:
```javascript
if (token.expiresAt < now + 5minutes) {
  // Refresh the token
  const response = await exchangeRefreshToken(refreshToken);
  token.accessToken = response.access_token;
  token.expiresAt = now + response.expires_in;
  saveToken(token);
}
```

### Revocation

User can revoke access in:
1. Google Account > Security > Your apps and sites
2. Or by clicking "Disconnect" in MCPEmails dashboard

When revoked, next API call gets `401 Unauthorized`. MCPEmails should:
1. Catch the error
2. Delete the stored tokens
3. Prompt user to reconnect

### Error Handling

**User denies permission**: Redirect back to inbox list with "Connection cancelled"

**Invalid scope**: Check MCPEmails OAuth app configuration in Google Console

**Token expired beyond refresh**: Prompt user to reconnect

## Outlook / Microsoft 365 OAuth Flow

### Overview

Outlook uses Microsoft Identity Platform (formerly Azure AD).

### Scopes Needed

- `Mail.Read` — Read emails
- `Mail.Send` — Send emails
- `offline_access` — Get refresh token

### Flow Steps

1. **User clicks "Connect Outlook"**
2. **Redirect to Microsoft** with app ID, scopes, and callback
3. **User signs in** and grants permission
4. **Microsoft redirects** with authorization code
5. **Backend exchanges code** for tokens
6. **Tokens stored** encrypted

### Token Lifetime

- **Access token**: 1 hour
- **Refresh token**: ~6 months or until revoked

### Refresh Logic

Same as Gmail (see above).

### Revocation

User can revoke in:
1. Microsoft Account > Security > Recent activity
2. Or "Disconnect" in MCPEmails dashboard

### Error Handling

Similar to Gmail. Handle `invalid_grant` (token expired beyond refresh) by prompting reconnection.

## Fastmail OAuth

### Overview

Fastmail uses OAuth but can also use app-specific passwords. MCPEmails primarily uses OAuth.

### Scopes Needed

- `email` — Email access
- `offline` — Refresh token

### Flow Steps

1. User clicks "Connect Fastmail"
2. Redirect to Fastmail OAuth endpoint
3. User signs in and grants permission
4. Fastmail redirects with code
5. Backend exchanges for tokens
6. Tokens stored

### Token Lifetime

- **Access token**: 1 year (unusually long)
- **Refresh token**: Never expires (unless revoked)

### Refresh Logic

Same as others, but tokens last much longer.

### Alternative: App Passwords

For extra security, Fastmail users can generate app-specific passwords instead of OAuth:

1. User generates password in Fastmail Settings
2. User enters in MCPEmails "Connect with password"
3. Password stored encrypted; used for IMAP/SMTP
4. No refresh needed; password doesn't expire

## Token Storage

### Encryption

All tokens are stored in Supabase with field encryption:

```javascript
// In database schema
CREATE TABLE inbox_credentials (
  id uuid primary key,
  workspace_id uuid not null,
  provider text not null, // 'gmail', 'outlook', 'fastmail'
  email text not null,
  encrypted_access_token text, // Encrypted
  encrypted_refresh_token text, // Encrypted
  token_expires_at timestamp,
  created_at timestamp default now(),
  updated_at timestamp default now()
);
```

### Security

- Tokens are encrypted at rest using Supabase's encryption
- Encryption key rotates automatically
- Tokens are never logged or displayed to users
- Only show first 5 and last 5 characters of token (masked)

## Common Issues

### "Invalid Scope" Error

**Cause**: OAuth app doesn't have permission for requested scope

**Solution**: 
1. Check scopes in OAuth app configuration
2. Add missing scopes
3. Users may need to reconnect to grant new scopes

### Refresh Token Expired

**Cause**: Refresh token is very old (6+ months); user revoked; password changed

**Solution**: 
1. Prompt user to reconnect
2. Delete old tokens
3. Start OAuth flow again

### Redirect URI Mismatch

**Cause**: Callback URL in code doesn't match OAuth app config

**Solution**:
1. Verify callback URL in OAuth app settings
2. For development: Use `localhost:3000/callback`
3. For production: Use `https://mcpemails.com/callback`

### "Denied by server" After Permission Grant

**Cause**: User already connected this account; OAuth app has state mismatch

**Solution**:
1. Check if account already connected
2. Allow user to reconnect (revoke old, grant new)
3. Implement state validation in callback

## Best Practices

1. **Request minimal scopes**: Only request what you need
2. **Handle refresh proactively**: Refresh 5 minutes before expiration
3. **Log errors, not tokens**: Never log access tokens
4. **Revoke on logout**: Delete tokens when user signs out
5. **Test token refresh**: Verify refresh logic regularly
6. **Monitor expiration**: Alert if refresh token getting old
7. **Support reconnection**: Make it easy to reconnect if needed

---

**Note**: This is a placeholder. More detailed flow diagrams and error recovery examples should be added.

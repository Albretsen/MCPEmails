# IMAP & SMTP Protocol Reference

## Overview

IMAP (Internet Message Access Protocol) is used to read emails. SMTP (Simple Mail Transfer Protocol) is used to send emails. This guide covers the IMAP/SMTP implementations for different email providers.

## Gmail

### IMAP Settings

**Server**: `imap.gmail.com`
**Port**: 993 (SSL/TLS)
**Username**: Full email address (e.g., user@gmail.com)
**Password**: App-specific password (not regular Gmail password)

**Special Notes**:
- Standard Gmail password doesn't work; requires app-specific password
- Generated in Google Account > Security > App passwords
- Requires 2FA enabled
- IMAP folder names use Gmail labels (e.g., `[Gmail]/Sent Mail`, `[Gmail]/Trash`)

### SMTP Settings

**Server**: `smtp.gmail.com`
**Port**: 587 (STARTTLS) or 465 (SSL)
**Username**: Full email address
**Password**: App-specific password

### Gmail API Alternative

MCPEmails uses Gmail API instead of IMAP/SMTP for Gmail:
- More reliable than IMAP
- Better error handling
- No app password needed (OAuth only)
- Direct message and attachment access

## Outlook / Microsoft 365

### IMAP Settings

**Server**: `imap-mail.outlook.com`
**Port**: 993 (SSL/TLS)
**Username**: Full email address
**Password**: Regular account password or app password

**Special Notes**:
- Support for OAuth (recommended) or basic auth
- Folder names: `Inbox`, `Sent`, `Trash`, etc. (standard names)
- Supports modern IMAP extensions

### SMTP Settings

**Server**: `smtp-mail.outlook.com`
**Port**: 587 (STARTTLS)
**Username**: Full email address
**Password**: Regular password or app password

### Microsoft Graph API Alternative

Like Gmail, Outlook also has a native API (Microsoft Graph):
- More reliable than IMAP/SMTP
- OAuth-based
- Recommended over IMAP/SMTP

## Fastmail

### IMAP Settings

**Server**: `imap.fastmail.com`
**Port**: 993 (SSL/TLS)
**Username**: Full email address
**Password**: App-specific password

**Special Notes**:
- Always use app-specific passwords (not main password)
- Generate in Fastmail Settings > Password & Security > App passwords
- Excellent IMAP support; full folder hierarchy
- Supports IMAP IDLE (push notifications)

### SMTP Settings

**Server**: `smtp.fastmail.com`
**Port**: 465 (SSL) or 587 (STARTTLS)
**Username**: Full email address
**Password**: App-specific password

### Fastmail Advantages

- Best IMAP/SMTP support of all providers
- No API limitations
- Excellent for MCP (can use IMAP directly)
- Fast, reliable servers

## Generic IMAP / Self-Hosted

For any other email provider:

1. **Find IMAP/SMTP servers**: Usually in provider's documentation
2. **Test connection**: Use openssl or telnet to verify
3. **Check credentials**: Username format (email or login name?)
4. **Verify ports**: Most use 993 (IMAP SSL) and 587/465 (SMTP)
5. **Test in MCPEmails**: Try connecting; check activity log for errors

**Example OpenSSL test**:
```bash
openssl s_client -connect imap.example.com:993
```

## Email Parsing

### Headers

Important headers to extract:
- `From`: Sender email address
- `To`: Recipient(s)
- `Subject`: Email subject
- `Date`: Sent date (parse as RFC 5322 format)
- `Message-ID`: Unique identifier
- `In-Reply-To`: ID of original message (for threads)
- `References`: Chain of message IDs (for conversation)

### Body

**Encoding**:
- `Content-Transfer-Encoding`: Usually `base64` or `quoted-printable`
- Decode before parsing
- Handle malformed encoding gracefully

**MIME Structure**:
- Emails can be multipart: `text/plain` + `text/html`
- Extract both; prefer HTML with fallback to plain text
- Handle embedded images: `Content-ID` references

### Attachments

**Extract**:
1. Find parts with `Content-Disposition: attachment`
2. Get filename from `filename=` parameter
3. Decode body (usually base64)
4. Store in secure location
5. Scan for malware before user download

**Common Issues**:
- Filename encoding: ISO-8859-1 vs UTF-8
- Missing filename: Generate placeholder
- Very large attachments: Stream instead of loading in memory

## Common Issues & Solutions

### Connection Fails

**Cause**: Wrong server, port, or firewall blocking
**Solution**: 
- Verify server address and port
- Test with `openssl s_client`
- Check firewall rules

### Authentication Fails

**Cause**: Wrong password, wrong username format, or expired token
**Solution**:
- For Gmail/Outlook: Regenerate app password
- For self-hosted: Verify username format (email vs login)
- Check if 2FA is enabled and blocking

### IMAP IDLE Not Working

**Cause**: Server doesn't support IDLE or network timeout
**Solution**:
- Fall back to polling
- Poll every 30 seconds to 5 minutes
- Check server documentation for support

### Email Parsing Errors

**Cause**: Malformed email, unsupported encoding, or malicious content
**Solution**:
- Validate all inputs
- Use robust MIME parser
- Handle errors gracefully; don't crash
- Log issues for debugging

### Rate Limits

**Gmail**: ~500 requests/hour
**Outlook**: ~1000 requests/hour
**Fastmail**: ~1000 requests/hour

**Solution**: 
- Cache results
- Batch operations
- Implement exponential backoff on failure

---

**Note**: This is a placeholder. More detailed examples and troubleshooting should be added.

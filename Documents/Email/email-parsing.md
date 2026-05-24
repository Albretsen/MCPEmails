# Email Parsing Guide

## Email Structure

A typical email message contains:

```
Headers:
  From: sender@example.com
  To: recipient@example.com
  Subject: Test Email
  Date: Wed, 24 May 2026 10:30:00 +0000
  Message-ID: <abc123@example.com>
  Content-Type: multipart/alternative

Body:
  (MIME boundary-separated parts)
  
  Part 1 (text/plain):
    This is the plain text version...
  
  Part 2 (text/html):
    <p>This is the HTML version...</p>
  
  Part 3 (image/png):
    (binary image data)
```

## Parsing Headers

### Required Headers

These headers should always be extracted:

| Header | Purpose | Format |
|--------|---------|--------|
| From | Sender email | RFC 5322 address format |
| To | Recipient(s) | Comma-separated RFC 5322 |
| Subject | Email subject | UTF-8 text (may be encoded) |
| Date | Sent time | RFC 5322 date-time |
| Message-ID | Unique ID | `<id@domain>` format |

### Optional but Useful

| Header | Purpose | Notes |
|--------|---------|-------|
| Cc | Carbon copy recipients | Parse like To |
| Bcc | Blind carbon copy | Usually not included in message |
| In-Reply-To | Original message ID | For threading |
| References | Message ID chain | For conversation history |
| Content-Type | MIME type | `type/subtype; parameters` |
| Content-Transfer-Encoding | Encoding method | base64, quoted-printable, 7bit, etc. |

### Parsing Example

```javascript
function parseHeaders(headerString) {
  const headers = {};
  const lines = headerString.split('\r\n');
  
  let currentHeader = null;
  for (const line of lines) {
    // Continuation lines start with whitespace
    if (line[0] === ' ' || line[0] === '\t') {
      headers[currentHeader] += ' ' + line.trim();
    } else {
      const [key, ...valueParts] = line.split(':');
      currentHeader = key.toLowerCase();
      headers[currentHeader] = valueParts.join(':').trim();
    }
  }
  
  return headers;
}
```

## Parsing Email Addresses

Email addresses can be in several formats:

```
simple@example.com
"John Doe" <john@example.com>
John Doe <john@example.com>
john+tag@example.com (with comment)
```

**Parsing**:
```javascript
function parseEmailAddress(addr) {
  // Extract email and name from format: "Name" <email@example.com>
  const match = addr.match(/(?:"([^"]+)"|([^<]+))\s*<([^>]+)>|^([^<>]+)$/);
  
  if (!match) return null;
  
  const name = match[1] || match[2] || '';
  const email = match[3] || match[4];
  
  return {
    name: name.trim(),
    email: email.trim().toLowerCase()
  };
}
```

## Parsing MIME Body

### Content-Type Header

The `Content-Type` header describes the message structure:

```
Content-Type: multipart/alternative; boundary="boundary123"
Content-Type: text/plain; charset="utf-8"
Content-Type: text/html; charset="utf-8"
Content-Type: image/png; name="screenshot.png"
Content-Type: application/pdf; filename="document.pdf"
```

### Multipart Messages

Multipart messages contain multiple "parts" separated by a boundary:

```
Content-Type: multipart/alternative; boundary="boundary123"

--boundary123
Content-Type: text/plain

This is the plain text version.

--boundary123
Content-Type: text/html

<p>This is the HTML version.</p>

--boundary123--
```

**Parsing**:
```javascript
function parseMultipart(body, boundary) {
  const parts = body.split(`--${boundary}`);
  const parsed = [];
  
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i].trim();
    if (part === '--') break; // End marker
    
    const [headerSection, ...bodyParts] = part.split('\r\n\r\n');
    const headers = parseHeaders(headerSection);
    const content = bodyParts.join('\r\n\r\n');
    
    parsed.push({ headers, content });
  }
  
  return parsed;
}
```

## Decoding Content

### Content-Transfer-Encoding

Most emails use base64 or quoted-printable encoding.

**Base64**:
```javascript
function decodeBase64(encoded) {
  return Buffer.from(encoded, 'base64').toString('utf-8');
}
```

**Quoted-Printable**:
```javascript
function decodeQuotedPrintable(encoded) {
  return encoded
    .replace(/=\r\n/g, '') // Soft line breaks
    .replace(/=([0-9A-F]{2})/g, (m, hex) => 
      String.fromCharCode(parseInt(hex, 16))
    );
}
```

### Charset Encoding

Always respect the `charset` parameter:

```javascript
function decodeContent(body, headers) {
  const contentType = headers['content-type'] || '';
  const charsetMatch = contentType.match(/charset=([^\s;]+)/i);
  const charset = charsetMatch ? charsetMatch[1].replace(/"/g, '') : 'utf-8';
  
  const encoding = headers['content-transfer-encoding']?.toLowerCase() || '7bit';
  
  let decoded;
  if (encoding === 'base64') {
    decoded = Buffer.from(body, 'base64');
  } else if (encoding === 'quoted-printable') {
    decoded = Buffer.from(decodeQuotedPrintable(body), 'utf-8');
  } else {
    decoded = Buffer.from(body, 'utf-8');
  }
  
  return decoded.toString(charset);
}
```

## Extracting Text and HTML

From a multipart email, extract text and HTML versions:

```javascript
function extractContent(parts) {
  let textVersion = null;
  let htmlVersion = null;
  
  for (const part of parts) {
    const contentType = part.headers['content-type'] || '';
    const isAttachment = part.headers['content-disposition'] === 'attachment';
    
    if (!isAttachment) {
      if (contentType.includes('text/plain') && !textVersion) {
        textVersion = decodeContent(part.content, part.headers);
      } else if (contentType.includes('text/html') && !htmlVersion) {
        htmlVersion = decodeContent(part.content, part.headers);
      }
    }
  }
  
  return {
    text: textVersion,
    html: htmlVersion || textVersion // Fallback to text
  };
}
```

## Extracting Attachments

```javascript
function extractAttachments(parts) {
  const attachments = [];
  
  for (const part of parts) {
    const disposition = part.headers['content-disposition'];
    if (disposition === 'attachment') {
      const contentType = part.headers['content-type'] || 'application/octet-stream';
      const filename = extractFilename(part.headers['content-disposition']);
      
      const data = decodeContent(part.content, part.headers);
      
      attachments.push({
        filename: filename || 'unnamed',
        mimeType: contentType,
        size: Buffer.byteLength(data),
        data: Buffer.from(data, 'utf-8')
      });
    }
  }
  
  return attachments;
}

function extractFilename(disposition) {
  const match = disposition?.match(/filename=([^\s;]+)/i);
  return match ? match[1].replace(/"/g, '') : null;
}
```

## Security Considerations

### HTML Sanitization

Never display raw HTML from emails. Sanitize first:

```javascript
const DOMPurify = require('isomorphic-dompurify');

function sanitizeHtml(html) {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'u', 'a', 'img', 'ul', 'li'],
    ALLOWED_ATTR: ['href', 'title', 'src', 'alt'],
    KEEP_CONTENT: true
  });
}
```

### Phishing Detection

Check for suspicious indicators:
- Links with misleading text (link text != URL domain)
- Unusual From headers
- Suspicious subject patterns

### Malware Scanning

Before serving attachments:
1. Check file extension whitelist
2. Scan with ClamAV or similar
3. Store in quarantine if suspicious
4. Require user approval before download

## Common Parsing Issues

### Malformed MIME Boundary

**Problem**: Email missing closing boundary marker

**Solution**: Handle gracefully; extract parts found

### Invalid Charset

**Problem**: Email claims charset that doesn't decode

**Solution**: Fall back to UTF-8; replace invalid bytes with `?`

### Extremely Large Attachments

**Problem**: Attachment too large to process

**Solution**: Stream instead of loading in memory; set size limit

### Mixed Line Endings

**Problem**: Email has `\r\n`, `\n`, or `\r` inconsistently

**Solution**: Normalize to `\r\n` before parsing

---

**Note**: This is a placeholder. Production-grade examples using libraries like `mailparser` should be referenced.

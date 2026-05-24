# Email Parsing Pipeline

## 1. Overview

When an AI agent calls a tool such as `list_emails` or `get_email`, the MCPEmails MCP server must take raw email bytes fetched from the provider (Gmail API, Microsoft Graph, or Fastmail JMAP) and return a clean, predictable JSON object in the `tools/call` response. The bytes arrive as a complete RFC 5322 message — headers, body, and any attached binary data — and they must be safe to embed in an LLM context window: no XSS vectors, no undecoded bytes, no provider-specific quirks leaking through.

The pipeline executes synchronously in a Next.js Route Handler that serves the MCP server's HTTP transport. Because the route runs on Vercel (serverless, 300 MB memory limit, 60 s default timeout), the pipeline must be non-blocking and must reject or truncate emails whose raw size exceeds 10 MB before loading them fully into memory.

```
Provider API response
        │
        ▼
[1] Size gate (> 10 MB → reject with metadata-only fallback)
        │
        ▼
[2] MIME structure parsing  (mailparser)
        │
        ├─ Headers extraction + RFC 2047 decoding
        │
        ├─ Multipart tree walk
        │        ├─ text/plain part selection
        │        ├─ text/html part selection
        │        └─ attachment extraction
        │
        └─ Content decoding (base64 / quoted-printable → Buffer → UTF-8)
                │
                ▼
        [3] HTML sanitisation  (isomorphic-dompurify)
                │
                ▼
        [4] Construct ParsedEmail
                │
                ▼
        [5] Serialise → MCP tools/call response
```

The single entry point for all callers is `parseEmail(rawBuffer: Buffer): Promise<ParsedEmail>`. It throws `EmailParseError` (a typed subclass of `Error`) for unrecoverable failures; callers wrap the result in an MCP execution-error response (`isError: true`) rather than letting exceptions propagate to the JSON-RPC layer.

---

## 2. MIME Structure Parsing

### Library choice: mailparser

`mailparser` (npm: `mailparser`, from the Nodemailer project) is the sole library responsible for turning raw RFC 5322 bytes into a structured object. It is chosen over writing a custom parser because:

- It handles all three multipart subtypes (`alternative`, `mixed`, `related`) and their arbitrary nesting.
- It normalises CRLF/LF/CR line endings before boundary splitting, eliminating the most common class of malformed messages.
- It decodes RFC 2047 encoded-words in headers and exposes parsed address objects.
- It is actively maintained, has no native add-ons (pure JS), and runs without modification on Vercel's Node.js 20 runtime.

```ts
import { simpleParser, ParsedMail } from 'mailparser';

async function parseMimeStructure(raw: Buffer): Promise<ParsedMail> {
  return simpleParser(raw, {
    skipHtmlToText: false,   // keep mailparser's html→text fallback for use below
    skipTextToHtml: true,    // we do not want auto-generated HTML; only real HTML parts
    skipImageLinks: true,    // do not inline cid: images into HTML
    maxHtmlLengthToParse: 5_000_000, // 5 MB HTML cap; larger HTML is dropped
  });
}
```

### Multipart boundaries

RFC 2046 requires the boundary string to appear at the start of a line, preceded by `--`, and terminated by `--boundary--` for the epilogue. `mailparser` handles:

- Boundaries that contain special characters (spaces, `+`, `/`).
- Nested `multipart/related` inside `multipart/alternative` inside `multipart/mixed` — the most common real-world structure sent by Gmail and Outlook.
- Missing closing boundary markers: `mailparser` treats the end of input as an implicit close, extracting all parts found.

### Header folding

RFC 5322 allows long headers to be split across lines with a leading whitespace continuation. `mailparser` unfolds these before any further processing. We do not implement custom header folding logic.

### Charset detection

`mailparser` reads the `charset` parameter from each part's `Content-Type` header and converts the part's bytes to a UTF-8 JavaScript string via the `iconv-lite` dependency it bundles. When the declared charset is absent or unrecognised, it falls back to UTF-8. If a part still contains invalid byte sequences after conversion, those bytes are replaced with the Unicode replacement character U+FFFD rather than throwing.

---

## 3. Header Extraction

After `mailparser` parses the message, the following headers are extracted and normalised into the `ParsedEmail.headers` object.

| Field | Source header | Normalisation |
|---|---|---|
| `from` | `From` | Single `EmailAddress`; lowercased `address` field |
| `to` | `To` | Array of `EmailAddress`; duplicates removed |
| `cc` | `Cc` | Array of `EmailAddress`; may be empty |
| `subject` | `Subject` | Trimmed UTF-8 string; decoded from RFC 2047 |
| `date` | `Date` | `Date` object; if absent, `null` |
| `messageId` | `Message-ID` | String with angle brackets stripped |
| `inReplyTo` | `In-Reply-To` | String with angle brackets stripped; `null` if absent |
| `references` | `References` | Array of message-ID strings with angle brackets stripped |

### RFC 2047 encoded-words

Many clients encode non-ASCII characters in headers using the encoded-word syntax:

```
Subject: =?UTF-8?B?SGVsbG8gV8O4cmxk?=
Subject: =?iso-8859-1?Q?Kj=E6rlighet?=
```

`mailparser` decodes both the Base64 (`B`) and quoted-printable (`Q`) variants before exposing the header value. Our code receives a plain UTF-8 JavaScript string and does not need to re-decode it. The only post-processing we apply is trimming leading and trailing whitespace, collapsing internal whitespace runs to a single space, and stripping U+0000 null bytes, which appear in some malformed Outlook-generated messages.

### Address normalisation

`mailparser` parses addresses into `{ name: string; address: string }` objects following RFC 5322. We additionally:

- Lowercase the `address` field.
- Trim the `name` field and HTML-decode it with the `he` library (some mailers encode display names with HTML entities, e.g. `Acme &amp; Co`).
- If a group syntax address appears (uncommon but valid), it is flattened into individual addresses.

```ts
import he from 'he';

function normaliseAddress(addr: { name?: string; address?: string }): EmailAddress {
  return {
    name: addr.name ? he.decode(addr.name.trim()) : '',
    address: (addr.address ?? '').toLowerCase().trim(),
  };
}
```

---

## 4. Body Extraction

### Part selection strategy

`mailparser` walks the MIME tree and exposes two top-level properties: `text` (the best `text/plain` part it found) and `html` (the best `text/html` part it found). "Best" means the deepest part inside a `multipart/alternative` block, which follows RFC 2046 § 5.1.4's guidance that alternatives should be listed in increasing order of fidelity.

We use these pre-selected values directly rather than re-walking the tree, because `mailparser`'s selection logic is correct for the vast majority of real-world messages. The only override we apply:

- If `mailparser` returns an empty `text` but a non-empty `html`, we derive `textBody` by stripping tags from the sanitised HTML using a simple regex pass. This keeps the plain-text representation honest — it is derived from exactly the HTML that will be returned, not from a separate unrelated part.
- If both `text` and `html` are empty or absent and the message has a single non-attachment part with an unrecognised `Content-Type`, we attempt to decode that part as UTF-8 text and use it as `textBody`.

### Fallback chain for `textBody`

```
1. mailparser.text                         (preferred)
2. strip_tags(sanitised html)              (if text absent, html present)
3. UTF-8 decode of sole non-attachment part (if both absent)
4. ''                                       (empty string, never null)
```

### Fallback chain for `htmlBody`

```
1. sanitise(mailparser.html)               (preferred)
2. null                                    (no HTML available)
```

`htmlBody` is always either a sanitised HTML string or `null`. It is never an empty string — a zero-length sanitisation result is treated as `null`.

---

## 5. Content Decoding

`mailparser` handles `Content-Transfer-Encoding` decoding internally before exposing part content. The encodings it supports, and their treatment:

| Encoding | Behaviour |
|---|---|
| `7bit` / `8bit` | Passed through as-is; charset conversion applied |
| `quoted-printable` | Soft line breaks (`=\r\n`) removed; hex sequences decoded |
| `base64` | Standard alphabet decoded; whitespace in encoded data tolerated |
| `binary` | Treated as raw bytes |
| absent / unknown | Treated as `7bit` |

After transfer-encoding decoding, `mailparser` converts the resulting bytes to a UTF-8 JavaScript string using `iconv-lite`. We do not call `Buffer.toString()` ourselves; we consume the string mailparser provides.

For attachments, `mailparser` exposes part content as a `Buffer` (raw bytes, not charset-converted), which we re-encode as base64 for the `ParsedEmail.attachments[].data` field. The charset conversion step is intentionally skipped for attachments — we preserve the original bytes and report the declared MIME type so the consumer can interpret them correctly.

---

## 6. HTML Sanitisation

### Why raw HTML must never be returned

The `tools/call` response is consumed by an LLM, and the text it produces may be rendered in a chat UI, injected into a document, or acted on by downstream tools. An unsanitised email body can contain:

- `<script>` tags that execute in a browser-rendered context.
- `<img src="https://tracker.example.com/pixel?id=...">` open tracking pixels that exfiltrate information when the LLM's host application renders HTML.
- CSS `position: fixed; z-index: 9999` overlays that hijack the UI.
- `javascript:` hrefs that execute code on click.
- Data-exfiltration via `<link rel="preconnect">` or `<meta http-equiv="refresh">`.
- Prompt-injection attacks embedded in invisible `<span style="color:white">` elements attempting to hijack the agent's behaviour.

Returning sanitised HTML eliminates these vectors without losing the structural information (headings, lists, tables, links) that is genuinely useful to the LLM.

### Library choice: isomorphic-dompurify

`isomorphic-dompurify` wraps DOMPurify with a jsdom backend so it can run in a Node.js environment without a real browser DOM. It is the de-facto standard for server-side HTML sanitisation in the JS ecosystem and is audited by the Cure53 security team.

### Allowed tags and attributes

The allowlist is deliberately narrow. Email HTML rarely needs more than this set to be legible:

```ts
import createDOMPurify from 'isomorphic-dompurify';
import { JSDOM } from 'jsdom';

const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window as unknown as Window);

// Computed once at module load, not per-email.
const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'a', 'abbr', 'b', 'blockquote', 'br', 'caption',
    'cite', 'code', 'col', 'colgroup', 'dd', 'del',
    'dfn', 'div', 'dl', 'dt', 'em', 'figcaption',
    'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark',
    'ol', 'p', 'pre', 'q', 's', 'samp', 'small',
    'span', 'strong', 'sub', 'sup', 'table', 'tbody',
    'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul',
  ],
  ALLOWED_ATTR: [
    'href',    // <a> — URLs validated below
    'title',
    'alt',
    'src',     // <img> — cid: URLs removed below
    'width',
    'height',
    'colspan',
    'rowspan',
    'datetime',
    'cite',
    'lang',
    'dir',
  ],
  // Never allow style= or on* event handlers.
  FORBID_ATTR: ['style', 'class'],
  // Remove elements whose content is also dangerous, rather than just stripping the tag.
  FORCE_BODY: true,
  // Do not return a full <html>/<body> document.
  WHOLE_DOCUMENT: false,
  KEEP_CONTENT: true,
} as const;

// Post-sanitise hook: rewrite or remove unsafe href/src values.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? '';
    // Allow only http(s) and mailto. Strip everything else (javascript:, data:, cid:).
    if (!/^(https?:|mailto:)/i.test(href)) {
      node.removeAttribute('href');
    } else {
      // Force external links to open safely.
      node.setAttribute('rel', 'noopener noreferrer');
      node.setAttribute('target', '_blank');
    }
  }
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') ?? '';
    // Remove tracking pixels and cid: inline images.
    // Only allow https: image sources. data: URIs are blocked.
    if (!/^https:/i.test(src)) {
      node.removeAttribute('src');
    }
  }
});

export function sanitiseHtml(raw: string): string | null {
  const result = DOMPurify.sanitize(raw, SANITIZE_CONFIG);
  return result.length > 0 ? result : null;
}
```

Excluded tags worth noting: `<script>`, `<style>`, `<link>`, `<meta>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, `<input>`, `<button>`. DOMPurify blocks these by default; the explicit allowlist means any tag not in `ALLOWED_TAGS` is stripped regardless of default behaviour changes in future DOMPurify releases.

`style` and `class` attributes are forbidden on all elements. Email marketers use `style` to hide phishing text from human readers while keeping it visible to parsers — removing it neutralises this technique.

---

## 7. Attachment Handling

### Extraction

`mailparser` collects all MIME parts with a `Content-Disposition: attachment` header, as well as parts with a `Content-Disposition: inline` header that have a `filename` parameter, into its `attachments` array. Each element exposes:

- `filename`: decoded string (RFC 5987 and RFC 2231 parameter encodings handled by mailparser).
- `contentType`: MIME type string, e.g. `application/pdf`.
- `size`: byte count of the decoded content.
- `content`: `Buffer` of the decoded bytes.

### The 10 MB attachment cap

A single attachment whose decoded size exceeds 10 MB is not included in the `ParsedEmail.attachments` array. Instead, a stub entry is written to `ParsedEmail.attachments` with `data: null` and `truncated: true`. This prevents the `tools/call` response from growing large enough to overflow the LLM's context window or Vercel's 4.5 MB response body limit.

The cap applies to individual attachments, not to the sum. An email with five 8 MB attachments has all five included (subject to the overall 10 MB raw email size gate in step 1 — which would have rejected the email before this point). In practice the total raw size gate is the binding constraint.

### Filename sanitisation

Filenames are sanitised before inclusion in the output:

- Path separators (`/`, `\`) are replaced with `_` to prevent path traversal if a caller writes the file to disk.
- Null bytes are removed.
- The filename is truncated to 255 characters.
- If no filename is present, the field is set to `'unnamed'` with the MIME type's subtype appended as a file extension where deterministic (e.g. `unnamed.pdf` for `application/pdf`).

```ts
function sanitiseFilename(raw: string | undefined, mimeType: string): string {
  if (!raw || raw.trim() === '') {
    const ext = mime.extension(mimeType); // mime-types npm package
    return ext ? `unnamed.${ext}` : 'unnamed';
  }
  return raw
    .replace(/[/\\]/g, '_')
    .replace(/\0/g, '')
    .slice(0, 255)
    .trim();
}
```

### Base64 re-encoding

Attachment bytes are stored in `ParsedEmail.attachments[].data` as a base64 string. This makes the field directly usable in the MCP `image` content type without additional transformation, and keeps the `ParsedEmail` interface JSON-serialisable throughout.

---

## 8. The Output Shape

Every successfully parsed email conforms to the following TypeScript interface. This is the contract between the parser and every MCP tool that returns email data.

```ts
export interface EmailAddress {
  name: string;        // Display name, HTML-decoded, trimmed. '' if absent.
  address: string;     // Lowercased email address.
}

export interface ParsedAttachment {
  filename: string;       // Sanitised filename.
  mimeType: string;       // MIME type, e.g. 'application/pdf'.
  size: number;           // Decoded byte count.
  data: string | null;    // Base64-encoded bytes, or null if truncated (> 10 MB).
  truncated: boolean;     // true when data is null due to size cap.
  contentId: string | null; // Content-ID for inline attachments, without angle brackets.
}

export interface ParsedEmailHeaders {
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;         // UTF-8 decoded, never null. '' if absent.
  date: Date | null;       // null if header is absent or unparseable.
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];    // May be empty.
}

export interface ParsedEmail {
  headers: ParsedEmailHeaders;
  textBody: string;          // Plain-text body. '' if none available.
  htmlBody: string | null;   // Sanitised HTML body. null if none available.
  attachments: ParsedAttachment[];
  // Diagnostic fields — not exposed in tool output but logged for debugging.
  _meta: {
    rawSizeBytes: number;
    parseWarnings: string[];  // Non-fatal issues encountered during parsing.
  };
}
```

### Mapping to an MCP tools/call response

The tool result serialises `ParsedEmail` as a JSON object in a `text` content block, with a parallel `structuredContent` field for clients that support it. Attachments with image MIME types are additionally emitted as separate `image` content blocks.

```ts
function toMcpToolResult(email: ParsedEmail): ToolCallResult {
  const content: ContentBlock[] = [];

  // Primary structured data as text (backwards compatible).
  const emailJson = JSON.stringify({
    from: email.headers.from,
    to: email.headers.to,
    cc: email.headers.cc,
    subject: email.headers.subject,
    date: email.headers.date?.toISOString() ?? null,
    messageId: email.headers.messageId,
    inReplyTo: email.headers.inReplyTo,
    references: email.headers.references,
    textBody: email.textBody,
    htmlBody: email.htmlBody,
    attachments: email.attachments.map(a => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      truncated: a.truncated,
      contentId: a.contentId,
      // data omitted from the structured block; inline images use the image block below.
    })),
  }, null, 2);

  content.push({ type: 'text', text: emailJson });

  // Inline images as MCP image blocks (only if not truncated).
  for (const att of email.attachments) {
    if (att.data && att.mimeType.startsWith('image/')) {
      content.push({ type: 'image', data: att.data, mimeType: att.mimeType });
    }
  }

  return { content, isError: false };
}
```

---

## 9. Edge Cases

### Malformed MIME boundaries

**Symptom**: The boundary string declared in `Content-Type` does not match what appears in the body, or the closing `--boundary--` epilogue is absent.

**Handling**: `mailparser` is tolerant of both. Missing close boundaries cause all parts found before EOF to be returned. Mismatched boundaries cause the entire body to be treated as a single part with the top-level `Content-Type`. We surface a warning in `_meta.parseWarnings` so operators can identify problematic senders.

### Missing Content-Type

**Symptom**: A part or the entire message has no `Content-Type` header.

**Handling**: RFC 2045 § 5.2 specifies that the default is `text/plain; charset=us-ascii`. `mailparser` follows this default. Our code treats the resulting string as the `textBody` candidate.

### Extremely large emails (streaming vs buffering)

The 10 MB raw size gate means no email larger than 10 MB reaches `simpleParser`. For emails below that limit, full buffering is acceptable — the maximum in-memory representation (raw buffer + parsed output + base64-encoded attachments) stays well under 30 MB, which fits comfortably within Vercel's serverless function memory limit.

For provider APIs that stream the raw message (e.g. Gmail's `format=raw` via the `users.messages.get` endpoint, which returns the message as a base64url-encoded string in a JSON response), we decode the base64url to a `Buffer` before calling `parseEmail`. We do not use a streaming MIME parser because:

1. The provider already buffers the message server-side before sending the JSON response.
2. `mailparser`'s streaming API does not expose a reliable size-before-parse mechanism, making early rejection harder.
3. Below 10 MB the memory cost is not a concern.

If future requirements demand processing emails larger than 10 MB, the approach is: use `mailparser`'s streaming API, accumulate parts as they arrive, enforce per-part size limits, and discard the body buffer once the part is processed, keeping only headers and attachment metadata.

### Invalid or unsupported charset

**Symptom**: A part declares `charset=x-user-defined` or `charset=koi8-r`, or the declared charset does not match the actual byte content.

**Handling**: `iconv-lite` (bundled by `mailparser`) supports most legacy charsets including KOI8-R, ISO-8859-*, Windows-125*, and GB2312. If the charset is not recognised, `iconv-lite` falls back to UTF-8 decoding. Invalid byte sequences are replaced with U+FFFD. We log the charset and the replacement count to `_meta.parseWarnings` when replacements occur.

The specific case of `charset=us-ascii` with non-ASCII bytes (common in older spam) is handled by treating the bytes as ISO-8859-1, which is identical to US-ASCII for the low 128 code points and round-trips correctly for the high 128.

### Deeply nested multipart

**Symptom**: An email has more than four levels of `multipart/` nesting (seen occasionally in forwarded-and-replied chains).

**Handling**: `mailparser` recurses without an explicit depth limit, but such messages are rare and their raw size typically causes them to be rejected at the 10 MB gate before nesting depth becomes a problem. We do not add an artificial recursion limit.

### Duplicate Message-IDs

**Symptom**: Two emails in the user's mailbox share the same `Message-ID` header (caused by some mailing list software that reuses IDs).

**Handling**: The parser does not deduplicate — this is a mailbox-level concern handled by the `sync` layer which assigns a provider-internal ID (Gmail's `id` field, Graph's `id` field) as the primary key in the database, never `Message-ID`.

---

## 10. Library Choices

### mailparser (npm: `mailparser`)

**Version**: `^3.7`
**Why**: The most complete RFC 5322 / MIME parser available in the Node.js ecosystem. Handles encoded-words, iconv-lite charset conversion, streaming and buffered modes, address parsing, and multipart recursion. Maintained by the Nodemailer team. Pure JavaScript — no native bindings, deploys to Vercel without build customisation.

**Alternatives considered**:
- `postal-mime`: Lighter, but does not handle all `iconv-lite` charsets and has weaker RFC 2047 coverage.
- Writing a custom parser: Not justified — the failure modes of MIME parsing are extensive and well-documented; mailparser handles them.

### he (npm: `he`)

**Version**: `^1.2`
**Why**: Decodes HTML entities in address display names and any text fields that arrive pre-HTML-encoded. Handles all named entities (`&amp;`, `&nbsp;`, etc.) and numeric references (`&#160;`, `&#x00A0;`). Tiny (< 1 KB minified), no dependencies.

**Alternatives considered**:
- `html-entities`: Similar functionality but slightly less comprehensive named-entity coverage.
- Native `DOMParser`: Not available in Node.js without jsdom overhead.

### isomorphic-dompurify (npm: `isomorphic-dompurify`)

**Version**: `^2.x` (or `^3.x` if released before project launch)
**Why**: DOMPurify is the industry standard for HTML sanitisation; it is Cure53-audited and the `isomorphic-dompurify` wrapper adds jsdom to make it work server-side. The hook API (`addHook`) allows post-sanitise attribute rewriting without writing a custom parser. The JSDOM instance is created once at module load (not per-email), so the per-email cost is just the sanitisation pass itself.

**Alternatives considered**:
- `sanitize-html`: Regex-based, does not use a real DOM parser, and has a history of bypasses with malformed HTML. Rejected.
- `xss` (npm): Similar regex-based approach with similar bypass history. Rejected.
- Server-side rendering into a sandboxed iframe: Unnecessarily complex, not applicable in a serverless environment.

### mime-types (npm: `mime-types`)

**Version**: `^2.1`
**Why**: Used only for the `extension()` call in `sanitiseFilename` to infer a file extension from a MIME type when the attachment has no filename. Lightweight, no dependencies.

---

## Example: Raw MIME → Parsed Output

### Input

```
MIME-Version: 1.0
From: =?UTF-8?B?Sm9obiBEb2U=?= <john@example.com>
To: "Alice Smith" <alice@example.com>, bob@example.com
Subject: =?iso-8859-1?Q?Kj=E6rlighet?=
Date: Mon, 20 May 2026 14:30:00 +0200
Message-ID: <CABCdef12345@mail.example.com>
In-Reply-To: <CABCdef11111@mail.example.com>
References: <CABCdef00000@mail.example.com>
 <CABCdef11111@mail.example.com>
Content-Type: multipart/alternative; boundary="==part_boundary_abc123=="

--==part_boundary_abc123==
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: quoted-printable

Hello Alice,

This is a test message with a smart quote =E2=80=9Clike this=E2=80=9D.

Best,
John

--==part_boundary_abc123==
Content-Type: text/html; charset=UTF-8
Content-Transfer-Encoding: base64

PGh0bWw+PGJvZHk+PHA+SGVsbG8gQWxpY2UsPGJyPjxicj5UaGlzIGlzIGEgdGVzdCBtZXNz
YWdlIHdpdGggYSBzbWFydCBxdW90ZSDigJxsaWtlIHRoaXPigJ0uPGEgaHJlZj0iaHR0cHM6
Ly9leGFtcGxlLmNvbSI+Q2xpY2sgaGVyZTwvYT48L3A+PC9ib2R5PjwvaHRtbD4=

--==part_boundary_abc123==--
```

### Output (`ParsedEmail`)

```json
{
  "headers": {
    "from": {
      "name": "John Doe",
      "address": "john@example.com"
    },
    "to": [
      { "name": "Alice Smith", "address": "alice@example.com" },
      { "name": "", "address": "bob@example.com" }
    ],
    "cc": [],
    "subject": "Kjærlighet",
    "date": "2026-05-20T12:30:00.000Z",
    "messageId": "CABCdef12345@mail.example.com",
    "inReplyTo": "CABCdef11111@mail.example.com",
    "references": [
      "CABCdef00000@mail.example.com",
      "CABCdef11111@mail.example.com"
    ]
  },
  "textBody": "Hello Alice,\n\nThis is a test message with a smart quote “like this”.\n\nBest,\nJohn",
  "htmlBody": "<p>Hello Alice,<br><br>This is a test message with a smart quote “like this”.<a href=\"https://example.com\" rel=\"noopener noreferrer\" target=\"_blank\">Click here</a></p>",
  "attachments": [],
  "_meta": {
    "rawSizeBytes": 1247,
    "parseWarnings": []
  }
}
```

Notes on this example:
- `Subject` is decoded from ISO-8859-1 quoted-printable encoded-word: `=E6` → `æ` → `Kjærlighet`.
- `From` display name is decoded from UTF-8 base64 encoded-word: `Sm9obiBEb2U=` → `John Doe`.
- `References` spans two lines (header folding) and is split into an array with angle brackets stripped.
- The quoted-printable soft line break sequences and `=E2=80=9C` / `=E2=80=9D` (UTF-8 encoding of U+201C/U+201D) are decoded to the correct Unicode curly quotes.
- The `<html>` and `<body>` wrapper tags are stripped by DOMPurify's `WHOLE_DOCUMENT: false` setting.
- The `<a href>` survives sanitisation (it is an `https:` URL) and gains `rel` and `target` attributes from the post-sanitise hook.

---

*Document status: authoritative. Update when the parsing library versions change or the `ParsedEmail` interface is modified.*

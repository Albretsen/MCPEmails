/**
 * lib/email/parser.ts
 *
 * Email parsing utility — converts raw RFC 5322 email bytes into a clean,
 * typed ParsedEmail object suitable for inclusion in MCP tools/call responses.
 *
 * Pipeline:
 *   1. Size gate          — reject emails > 10 MB before full parse
 *   2. MIME structure     — mailparser handles multipart, charset, encoded-words
 *   3. Header extraction  — normalise addresses, strip angle brackets, etc.
 *   4. Body extraction    — text/plain and text/html with fallback chain
 *   5. HTML sanitisation  — isomorphic-dompurify removes XSS vectors
 *   6. Attachment list    — base64 re-encode, sanitise filenames, cap at 10 MB each
 *
 * Entry point: parseEmail(rawBuffer: Buffer): Promise<ParsedEmail>
 */

import { simpleParser, type ParsedMail, type Attachment } from 'mailparser';
import he from 'he';
import { extension as mimeExtension } from 'mime-types';
import { sanitiseHtml } from './sanitize';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EmailAddress {
  /** Display name, HTML-decoded and trimmed. Empty string if absent. */
  name: string;
  /** Lowercased email address. */
  address: string;
}

export interface ParsedAttachment {
  /** Sanitised filename safe for use in a file path. */
  filename: string;
  /** MIME type, e.g. 'application/pdf'. */
  mimeType: string;
  /** Decoded byte count. */
  size: number;
  /** Base64-encoded bytes, or null when the attachment exceeds the 10 MB cap. */
  data: string | null;
  /** true when data is null due to the size cap. */
  truncated: boolean;
  /** Content-ID for inline attachments, without angle brackets. null if absent. */
  contentId: string | null;
}

export interface ParsedEmailHeaders {
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  /** UTF-8 decoded subject line. Empty string if absent. */
  subject: string;
  /** Parsed Date object, or null if the header is absent or unparseable. */
  date: Date | null;
  /** Message-ID without angle brackets. null if absent. */
  messageId: string | null;
  /** In-Reply-To without angle brackets. null if absent. */
  inReplyTo: string | null;
  /** Array of referenced message IDs without angle brackets. May be empty. */
  references: string[];
}

export interface ParsedEmail {
  headers: ParsedEmailHeaders;
  /** Plain-text body. Empty string if none available — never null. */
  textBody: string;
  /** Sanitised HTML body, or null if none available. */
  htmlBody: string | null;
  attachments: ParsedAttachment[];
  /** Diagnostic metadata — logged internally, not exposed in tool output. */
  _meta: {
    rawSizeBytes: number;
    parseWarnings: string[];
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EmailParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'EmailParseError';
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum raw email size accepted for full parsing. */
const MAX_RAW_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Maximum decoded attachment size included verbatim in the output. */
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse a raw RFC 5322 email buffer into a typed ParsedEmail.
 *
 * @throws {EmailParseError} for unrecoverable failures (e.g. raw size > 10 MB).
 *   Callers should catch this and return an MCP execution-error response.
 */
export async function parseEmail(rawBuffer: Buffer): Promise<ParsedEmail> {
  const warnings: string[] = [];

  // Step 1: size gate — reject before full parse to protect memory.
  if (rawBuffer.byteLength > MAX_RAW_SIZE_BYTES) {
    throw new EmailParseError(
      `Email raw size ${rawBuffer.byteLength} bytes exceeds the 10 MB limit.`
    );
  }

  // Step 2: MIME structure parsing via mailparser.
  let parsed: ParsedMail;
  try {
    parsed = await simpleParser(rawBuffer, {
      skipHtmlToText: false,
      skipTextToHtml: true,
      skipImageLinks: true,
      maxHtmlLengthToParse: 5_000_000,
    });
  } catch (err) {
    throw new EmailParseError('Failed to parse MIME structure.', err);
  }

  // Step 3: header extraction.
  const headers = extractHeaders(parsed, warnings);

  // Step 4 & 5: body extraction + HTML sanitisation.
  const { textBody, htmlBody } = extractBody(parsed, warnings);

  // Step 6: attachment extraction.
  const attachments = extractAttachments(parsed, warnings);

  return {
    headers,
    textBody,
    htmlBody,
    attachments,
    _meta: {
      rawSizeBytes: rawBuffer.byteLength,
      parseWarnings: warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Header extraction
// ---------------------------------------------------------------------------

function extractHeaders(parsed: ParsedMail, warnings: string[]): ParsedEmailHeaders {
  return {
    from: extractSingleAddress(parsed.from, warnings),
    to: extractAddressList(parsed.to, warnings),
    cc: extractAddressList(parsed.cc, warnings),
    subject: normaliseSubject(parsed.subject),
    date: parsed.date instanceof Date ? parsed.date : null,
    messageId: stripAngleBrackets(parsed.messageId),
    inReplyTo: stripAngleBrackets(parsed.inReplyTo),
    references: extractReferences(parsed.references),
  };
}

/** Normalise a single address field (From:). Falls back to an empty address. */
function extractSingleAddress(
  field: ParsedMail['from'],
  warnings: string[]
): EmailAddress {
  if (!field || !field.value || field.value.length === 0) {
    warnings.push('From header absent or unparseable.');
    return { name: '', address: '' };
  }
  return normaliseAddress(field.value[0]);
}

/** Normalise an address list field (To:, Cc:). Flattens group syntax. */
function extractAddressList(
  field: ParsedMail['to'] | ParsedMail['cc'],
  _warnings: string[]
): EmailAddress[] {
  if (!field) return [];

  // mailparser returns AddressObject | AddressObject[]
  const objects = Array.isArray(field) ? field : [field];
  const addresses: EmailAddress[] = [];

  for (const obj of objects) {
    for (const addr of obj.value ?? []) {
      // Group syntax: addr.group is the group name, members are in addr.value — not applicable here
      // mailparser flattens groups into the value array for To/Cc already.
      addresses.push(normaliseAddress(addr));
    }
  }

  // Remove duplicates by lowercased address.
  const seen = new Set<string>();
  return addresses.filter((a) => {
    if (seen.has(a.address)) return false;
    seen.add(a.address);
    return true;
  });
}

/** Normalise a single parsed address: lowercase the email, HTML-decode the name. */
function normaliseAddress(addr: { name?: string; address?: string }): EmailAddress {
  const rawName = addr.name?.trim() ?? '';
  const name = rawName ? he.decode(rawName) : '';
  const address = (addr.address ?? '').toLowerCase().trim();
  return { name, address };
}

/** Trim, collapse whitespace, and strip null bytes from a subject string. */
function normaliseSubject(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/\0/g, '')          // strip null bytes (malformed Outlook messages)
    .replace(/\s+/g, ' ')        // collapse internal whitespace
    .trim();
}

/** Strip leading/trailing angle brackets from a message-ID string. */
function stripAngleBrackets(raw: string | undefined): string | null {
  if (!raw) return null;
  return raw.replace(/^<|>$/g, '').trim() || null;
}

/** Parse the References header into an array of clean message-IDs. */
function extractReferences(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const joined = Array.isArray(raw) ? raw.join(' ') : raw;
  // References is a whitespace-separated list of <id> tokens.
  return joined
    .split(/\s+/)
    .map((id) => id.replace(/^<|>$/g, '').trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Body extraction
// ---------------------------------------------------------------------------

function extractBody(
  parsed: ParsedMail,
  warnings: string[]
): { textBody: string; htmlBody: string | null } {
  // --- HTML body (sanitised) ---
  let htmlBody: string | null = null;
  if (parsed.html) {
    htmlBody = sanitiseHtml(parsed.html);
    // sanitiseHtml returns null for empty results.
  }

  // --- Text body (fallback chain) ---
  let textBody: string;

  if (parsed.text && parsed.text.trim().length > 0) {
    // 1. mailparser's text/plain part — preferred.
    textBody = parsed.text;
  } else if (htmlBody) {
    // 2. Strip tags from the sanitised HTML.
    textBody = stripTags(htmlBody);
    warnings.push('textBody derived from HTML body: no text/plain part present.');
  } else if (parsed.html && !htmlBody) {
    // 3. HTML existed but was fully stripped by sanitiser; derive from raw HTML.
    textBody = stripTags(parsed.html);
    warnings.push('textBody derived from raw HTML: sanitised HTML was empty.');
  } else {
    // 4. Empty string — never null.
    textBody = '';
    warnings.push('No text or HTML body parts found.');
  }

  return { textBody, htmlBody };
}

/** Minimal tag stripper for deriving plain text from HTML. */
function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/(?:div|h[1-6]|li|tr|th|td|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Attachment extraction
// ---------------------------------------------------------------------------

function extractAttachments(
  parsed: ParsedMail,
  warnings: string[]
): ParsedAttachment[] {
  if (!parsed.attachments || parsed.attachments.length === 0) return [];

  return parsed.attachments.map((att) => extractAttachment(att, warnings));
}

function extractAttachment(
  att: Attachment,
  warnings: string[]
): ParsedAttachment {
  const mimeType = att.contentType ?? 'application/octet-stream';
  const filename = sanitiseFilename(att.filename, mimeType);
  const size = att.size ?? (att.content?.byteLength ?? 0);

  // Content-ID: strip angle brackets if present.
  const contentId = att.contentId
    ? att.contentId.replace(/^<|>$/g, '').trim() || null
    : null;

  // Per-attachment 10 MB cap.
  if (size > MAX_ATTACHMENT_SIZE_BYTES) {
    warnings.push(
      `Attachment "${filename}" (${size} bytes) exceeds the 10 MB cap — data omitted.`
    );
    return { filename, mimeType, size, data: null, truncated: true, contentId };
  }

  // Re-encode decoded bytes as base64 for the MCP response.
  const data = att.content ? att.content.toString('base64') : null;

  return { filename, mimeType, size, data, truncated: false, contentId };
}

/**
 * Sanitise an attachment filename:
 * - Replace path separators with underscore (prevent path traversal).
 * - Remove null bytes.
 * - Truncate to 255 characters.
 * - Fall back to 'unnamed[.ext]' when no filename is provided.
 */
function sanitiseFilename(raw: string | undefined, mimeType: string): string {
  if (!raw || raw.trim() === '') {
    const ext = mimeExtension(mimeType);
    return ext ? `unnamed.${ext}` : 'unnamed';
  }

  return raw
    .replace(/[/\\]/g, '_')
    .replace(/\0/g, '')
    .slice(0, 255)
    .trim();
}

// ---------------------------------------------------------------------------
// MCP serialisation helper
// ---------------------------------------------------------------------------

export interface McpContentBlock {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolResult {
  content: McpContentBlock[];
  isError: false;
}

/**
 * Serialise a ParsedEmail into an MCP tools/call response.
 *
 * The primary payload is emitted as a JSON text block for backwards-compatible
 * clients. Images are additionally emitted as separate MCP image content blocks
 * for clients that support the structured content type.
 */
export function toMcpToolResult(email: ParsedEmail): McpToolResult {
  const content: McpContentBlock[] = [];

  const emailJson = JSON.stringify(
    {
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
      attachments: email.attachments.map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        truncated: a.truncated,
        contentId: a.contentId,
        // `data` is intentionally omitted from the text block;
        // inline images use the dedicated image content block below.
      })),
    },
    null,
    2
  );

  content.push({ type: 'text', text: emailJson });

  // Emit image attachments as MCP image content blocks (only if not truncated).
  for (const att of email.attachments) {
    if (att.data !== null && att.mimeType.startsWith('image/')) {
      content.push({ type: 'image', data: att.data, mimeType: att.mimeType });
    }
  }

  return { content, isError: false };
}

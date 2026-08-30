// ---------------------------------------------------------------------------
// mime-build.ts — RFC 5322 / MIME SERIALIZATION for outgoing mail (Deno).
//
// Extracted verbatim from index.ts on 2026-08-30 so the BCC rules below can be
// unit-tested. Nothing here touches the network, the database or Deno.env: give
// it parameters, get a string back. Its counterpart is mime.ts, which PARSES
// incoming messages; this module WRITES outgoing ones.
//
// ── THE BCC RULE, WHICH IS THE WHOLE REASON THIS FILE EXISTS ───────────────
//
// A `Bcc:` header is written only when `includeBccHeader` is set, and the
// question that flag answers is not "is this a draft?" but "who removes the
// header before a To/Cc recipient sees it?". Getting it wrong in one direction
// silently drops the BCC recipients; in the other it leaks the BCC list to
// everyone on the To line. Both were live in production on 2026-08-30 — see
// the flag's own documentation for the per-provider answer and the tests in
// mime-build.test.ts for the assertions that hold it in place.
// ---------------------------------------------------------------------------

/**
 * Encode a UTF-8 text string as base64, split into 76-character lines per
 * MIME spec (RFC 2045). Used for text/plain and text/html body parts with
 * Content-Transfer-Encoding: base64.
 */
export function encodeTextAsBase64Lines(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const binaryStr = Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join("");
  const b64 = btoa(binaryStr);
  return b64.match(/.{1,76}/g)?.join("\r\n") ?? b64;
}

/**
 * Encode a MIME header value containing non-ASCII characters using RFC 2047
 * encoded-word syntax: =?UTF-8?B?<base64>?=
 * ASCII-only values are returned unchanged.
 */
export function encodeMimeHeaderValue(value: string): string {
  // SECURITY: strip CR/LF (and other control chars) BEFORE the ASCII
  // fast-path. CR and LF are ASCII, so without this an attacker-controlled
  // value containing CRLF would be injected verbatim into MIME headers
  // (header injection → hidden Bcc:, header/body splitting). Collapse any
  // run of control characters into a single space.
  // deno-lint-ignore no-control-regex
  const sanitized = value.replace(/[\x00-\x1F\x7F]+/g, " ");
  // deno-lint-ignore no-control-regex
  if (/^[\x00-\x7F]*$/.test(sanitized)) {
    return sanitized;
  }
  const bytes = new TextEncoder().encode(sanitized);
  const binaryStr = Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join("");
  return `=?UTF-8?B?${btoa(binaryStr)}?=`;
}

/**
 * Split base64 attachment data into 76-character lines per MIME spec.
 * Strips existing whitespace before re-chunking.
 */
export function chunkBase64(b64: string): string {
  const clean = b64.replace(/\s/g, "");
  return clean.match(/.{1,76}/g)?.join("\r\n") ?? clean;
}

export interface MimeMessageParams {
  /** "Display Name <email>" or just "email" */
  from: string;
  to: string[];
  cc?: string[];
  /**
   * BCC recipients. Written as a real `Bcc:` header ONLY when
   * `includeBccHeader` is set; see that flag for who may set it and why.
   */
  bcc?: string[];
  /**
   * When true, write a `Bcc:` header into the MIME.
   *
   * The question this flag answers is NOT "is this a draft?" — it is "who
   * removes the Bcc header before the message reaches a To/Cc recipient?".
   * There are exactly two acceptable answers, and each provider is one or the
   * other:
   *
   *   * WE remove it. SMTP submission (imapSmtpSend) carries BCC in the
   *     envelope — RCPT TO — so the header is redundant there and must not be
   *     transmitted. A stored IMAP draft still SETS the flag, because
   *     draft_send rebuilds its recipient list by re-parsing the stored MIME
   *     and the header is the only place the BCC survives; `stripBccHeader`
   *     then takes it back out of the copy that goes on the wire.
   *   * GOOGLE removes it. Gmail has no envelope to carry: `users.messages.send`
   *     and `users.drafts.send` both take `raw` and nothing else, and both are
   *     documented as sending "to the recipients in the To, Cc, and Bcc
   *     headers". The header IS the recipient channel, so omitting it does not
   *     make BCC private — it makes BCC not happen. Google's submission agent
   *     performs the RFC 5322 §3.6.3 removal, exactly as it does for drafts
   *     composed in Gmail's own web client, which store a Bcc header too.
   *
   * Outlook never reaches this code: Graph takes structured `bccRecipients`
   * on both the send and the draft path, so there is no MIME to annotate.
   *
   * Do not set this flag for any new caller without answering the question
   * above for that caller's transport. Getting it wrong in one direction
   * silently drops the BCC recipients; in the other it leaks the BCC list to
   * everyone on the To line.
   */
  includeBccHeader?: boolean;
  subject: string;
  textBody: string;
  htmlBody?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    /** Standard base64-encoded binary data */
    data: string;
  }>;
  replyTo?: string;
  /** Pre-generated UUID (without angle brackets) used as Message-ID */
  messageId: string;
  /**
   * RFC 5322 Message-ID of the message being replied to.
   * Written as the `In-Reply-To` MIME header.
   */
  inReplyTo?: string;
  /**
   * Full RFC 5322 References header chain (existing refs + original message ID).
   * Written as the `References` MIME header.
   */
  references?: string;
}

/**
 * Build an RFC 5322 / MIME message string from the given parameters.
 *
 * Structure selection:
 *   - Plain text only, no attachments       → text/plain
 *   - Text + HTML, no attachments           → multipart/alternative
 *   - Text only + attachments               → multipart/mixed
 *   - Text + HTML + attachments             → multipart/mixed with nested
 *                                             multipart/alternative
 *
 * Body content is base64-encoded (Content-Transfer-Encoding: base64) for
 * reliable UTF-8 transport. Attachment data passes through as-is — the caller
 * provides base64 data from the MCP tool arguments.
 *
 * SECURITY: a `Bcc:` header is written only when `includeBccHeader` is set, and
 * the rule for setting it is documented on the flag itself: it says who strips
 * the header before a To/Cc recipient sees it. On the SMTP path that is us
 * (the envelope carries BCC, and stripBccHeader removes the header from the
 * transmitted copy of a draft); on the Gmail path that is Google, whose
 * `raw`-only send APIs take their recipient list from this very header. It is
 * never set for Outlook, which takes structured `bccRecipients` instead.
 */
export function buildMimeMessage(params: MimeMessageParams): string {
  const boundary = `mcpe_${crypto.randomUUID().replace(/-/g, "")}`;
  const lines: string[] = [];

  // ── Required headers ──────────────────────────────────────────────────────
  lines.push(`From: ${params.from}`);
  lines.push(`To: ${params.to.join(", ")}`);
  if (params.cc?.length) lines.push(`Cc: ${params.cc.join(", ")}`);
  // Bcc is written ONLY for draft persistence (includeBccHeader). It is stripped
  // before transmission so To/Cc recipients never see BCC addresses.
  if (params.includeBccHeader && params.bcc?.length) {
    lines.push(`Bcc: ${params.bcc.join(", ")}`);
  }
  lines.push(`Subject: ${encodeMimeHeaderValue(params.subject)}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`Message-ID: <${params.messageId}@mcpemails.com>`);
  if (params.replyTo) lines.push(`Reply-To: ${params.replyTo}`);
  if (params.inReplyTo) lines.push(`In-Reply-To: ${params.inReplyTo}`);
  if (params.references) lines.push(`References: ${params.references}`);
  lines.push(`MIME-Version: 1.0`);

  const hasHtml = !!params.htmlBody;
  const hasAttachments = !!(params.attachments?.length);

  if (!hasHtml && !hasAttachments) {
    // ── Simple text/plain ─────────────────────────────────────────────────
    lines.push(`Content-Type: text/plain; charset=UTF-8`);
    lines.push(`Content-Transfer-Encoding: base64`);
    lines.push("");
    lines.push(encodeTextAsBase64Lines(params.textBody));
  } else if (hasHtml && !hasAttachments) {
    // ── multipart/alternative (plain text + HTML, no attachments) ─────────
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: text/plain; charset=UTF-8`);
    lines.push(`Content-Transfer-Encoding: base64`);
    lines.push("");
    lines.push(encodeTextAsBase64Lines(params.textBody));
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: text/html; charset=UTF-8`);
    lines.push(`Content-Transfer-Encoding: base64`);
    lines.push("");
    lines.push(encodeTextAsBase64Lines(params.htmlBody!));
    lines.push("");
    lines.push(`--${boundary}--`);
  } else {
    // ── multipart/mixed (body ± HTML alternative + attachments) ───────────
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push("");

    if (hasHtml) {
      // Nested multipart/alternative for the body
      const altBoundary = `mcpe_alt_${crypto.randomUUID().replace(/-/g, "")}`;
      lines.push(`--${boundary}`);
      lines.push(
        `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      );
      lines.push("");
      lines.push(`--${altBoundary}`);
      lines.push(`Content-Type: text/plain; charset=UTF-8`);
      lines.push(`Content-Transfer-Encoding: base64`);
      lines.push("");
      lines.push(encodeTextAsBase64Lines(params.textBody));
      lines.push("");
      lines.push(`--${altBoundary}`);
      lines.push(`Content-Type: text/html; charset=UTF-8`);
      lines.push(`Content-Transfer-Encoding: base64`);
      lines.push("");
      lines.push(encodeTextAsBase64Lines(params.htmlBody!));
      lines.push("");
      lines.push(`--${altBoundary}--`);
    } else {
      // Plain text body part only
      lines.push(`--${boundary}`);
      lines.push(`Content-Type: text/plain; charset=UTF-8`);
      lines.push(`Content-Transfer-Encoding: base64`);
      lines.push("");
      lines.push(encodeTextAsBase64Lines(params.textBody));
    }

    // Attachment parts
    for (const att of params.attachments ?? []) {
      lines.push("");
      lines.push(`--${boundary}`);
      lines.push(
        // SECURITY: att.mimeType previously interpolated raw — route it through
        // encodeMimeHeaderValue so CR/LF/control chars can't inject headers.
        `Content-Type: ${encodeMimeHeaderValue(att.mimeType)}; name="${encodeMimeHeaderValue(att.filename)}"`,
      );
      lines.push(
        `Content-Disposition: attachment; filename="${encodeMimeHeaderValue(att.filename)}"`,
      );
      lines.push(`Content-Transfer-Encoding: base64`);
      lines.push("");
      lines.push(chunkBase64(att.data));
    }

    lines.push("");
    lines.push(`--${boundary}--`);
  }

  return lines.join("\r\n");
}

/**
 * Convert an RFC 5322 MIME message string to base64url as required by the
 * Gmail API `messages.send` endpoint (the `raw` field).
 *
 * The message must already use \r\n line endings (per MIME spec).
 */
export function mimeMessageToBase64url(mimeText: string): string {
  const bytes = new TextEncoder().encode(mimeText);
  const binaryStr = Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join("");
  return btoa(binaryStr)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * MIME for a draft that is being STORED, not sent.
 *
 * A draft may legitimately have no recipient yet (that is the whole point of a
 * draft), so an empty To list must produce a message with NO To header. Until
 * 2026-08-30 these paths passed `[inbox.email_address]` instead, which made a
 * recipientless draft look addressed to the account owner in the stored MIME
 * while draft_create still reported `"to": []`. draft_send then transmitted it,
 * and the mail arrived at the owner: nobody chose that recipient, the fallback
 * did. The recipient REQUIREMENT lives at send time (draftIsSendable), not
 * here.
 */
export function buildDraftMime(params: MimeMessageParams): string {
  const mime = buildMimeMessage(params);
  // buildMimeMessage always writes a To line; drop it when it is empty.
  return params.to.length ? mime : mime.replace(/^To:[ \t]*\r?\n/m, "");
}

/**
 * Remove every `Bcc:` header (including folded continuation lines) from a raw
 * RFC 5322 message, operating only on the header block (before the first blank
 * line). A persisted IMAP draft may legitimately contain a Bcc header (it's the
 * user's own copy), but the SENT copy MUST NOT — BCC may only affect the SMTP
 * envelope. The BCC addresses are read from the stored MIME for RCPT TO and
 * then this strips the header from the transmitted body.
 */
export function stripBccHeader(rawMime: string): string {
  // Split header block from body on the first blank line (CRLF or LF).
  const sep = rawMime.search(/\r?\n\r?\n/);
  if (sep === -1) return rawMime; // No body separator — treat whole thing as headers below.
  const headerEnd = sep;
  const headerBlock = rawMime.slice(0, headerEnd);
  const rest = rawMime.slice(headerEnd); // includes the leading blank-line separator

  const headerLines = headerBlock.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of headerLines) {
    const isContinuation = /^[ \t]/.test(line);
    if (skipping) {
      // Folded continuation of a Bcc header — keep dropping it.
      if (isContinuation) continue;
      skipping = false;
    }
    if (/^bcc[ \t]*:/i.test(line)) {
      skipping = true; // Drop this header line and any folded continuations.
      continue;
    }
    kept.push(line);
  }
  return kept.join("\r\n") + rest;
}

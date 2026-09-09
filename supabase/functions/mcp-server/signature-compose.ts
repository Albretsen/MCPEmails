// ---------------------------------------------------------------------------
// signature-compose: how a plain body and a per-inbox signature become the
// text/HTML pair that is actually sent
// ---------------------------------------------------------------------------
//
// No mail backend (Gmail messages.send, Graph sendMail, JMAP Email/send, SMTP)
// appends a signature: the signature you normally see is added by the client
// UI. These helpers append a per-inbox signature server-side so programmatic
// mail looks like mail the user sends. Signature storage lives on the inboxes
// row (signature_html / signature_text / signature_enabled / ...).
//
// WHY THIS IS A MODULE AND NOT STILL A BLOCK IN index.ts. Same reason as
// mime-build.ts, text-safety.ts and signature-sanitizer.ts: it is pure string
// work with a real test suite, and index.ts calls Deno.serve and builds a
// service-role client at module load, so a test cannot import it. That mattered
// concretely here, because the two bugs this module was extracted for were both
// invisible to the suite:
//
//   1. A `body_text`-only edit through `approval_update` rewrote the text part
//      and left the HTML part saying the PRE-EDIT wording, which is what most
//      mail clients render. The approval edit path lives in
//      mcp-app-approvals.ts, which cannot import index.ts either, so before
//      this module there was no way for it to regenerate the HTML part through
//      the same synthesis that produced it, short of hand-rolling a second
//      text-to-HTML conversion, i.e. a second thing to drift.
//   2. A held `email_send` was signed at enqueue time AND again when the
//      approved snapshot was re-dispatched. See `includeSignatureForSend`.
//
// PURE: no DB or network I/O. Reply/forward placement (signature before the
// quoted block, honouring signature_reply_mode) stays in index.ts with the
// quoting it is interleaved with; these helpers cover the plain "new message"
// case, which is the one whose output gets stored, reviewed and re-sent.
// ---------------------------------------------------------------------------

import { sanitizeSignatureHtmlSafe } from "./signature-sanitizer.ts";

/**
 * The RFC 3676 signature delimiter: dash-dash-space-newline, preceded by a
 * blank line. Exported because more than one module needs to RECOGNISE it, not
 * just emit it.
 */
export const SIGNATURE_TEXT_DELIMITER = "\n\n-- \n";

/** The class on the wrapper div that marks our own HTML signature block. */
export const SIGNATURE_HTML_CLASS = "mcpemails-signature";

/** Minimal HTML-escape for deriving HTML from plain text. */
export function escapeSignatureHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * THE one plain-text-to-HTML body synthesis. Every place that has to produce an
 * HTML alternative for a text body a caller supplied goes through here:
 * `applySignature` below when a text-only send needs an HTML part for the rich
 * signature, and `runApprovalUpdate` when a text-only edit has to bring the
 * stored HTML part back in line with the new text.
 *
 * Escaping is the entire security story of this function. The input is
 * caller-supplied text that is about to become markup, and every byte of output
 * is either a byte this function escaped or a `<br>` it wrote itself, so there
 * is nothing for a sanitizer to do downstream. The sanitizers exist for markup
 * someone ELSE wrote (a stored signature, an inbound body), not for text we are
 * escaping ourselves. Do not "improve" this by passing the result through
 * sanitizeEmailHtml: that would be a second, weaker guarantee layered over a
 * total one.
 */
export function plainTextBodyToHtml(text: string): string {
  return escapeSignatureHtml(text).replace(/\n/g, "<br>\n");
}

/**
 * Convert SIGNATURE html to its plain-text half.
 *
 * Deliberately separate from `stripHtmlToText`, which serves arbitrary email
 * bodies: signatures are almost always laid out as a `<table>`, and that
 * function only breaks on `<br>`/`</p>`/`</div>`. A cell-based signature
 * therefore flattened into one run-on line ("Asgeir AlbretsenFounder · MCP
 * Emails"). Here every cell and row boundary is a line break, because plain
 * text has no columns and one cell per line is the only faithful rendering.
 * Widening `stripHtmlToText` itself would reshape `body_text` for every
 * table-heavy marketing email an agent reads, so the two stay independent.
 */
export function signatureHtmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|td|th|li|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    // Empty cells (a logo `<td>`, a spacer row) each contribute a newline;
    // squeeze the runs so the signature keeps its shape.
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The signature columns of an inbox row. Structural on purpose: index.ts passes
 * its full `InboxRow`, the approval module passes the narrow projection it
 * selects, and neither has to know about the other.
 */
export interface SignatureInbox {
  signature_enabled?: boolean | null;
  signature_text?: string | null;
  signature_html?: string | null;
}

/**
 * Resolve the signature for an inbox into a normalized `{ text, html }` pair.
 *
 * Returns `null` when no signature should be appended (disabled, or both
 * stored fields empty). When only one half is stored, the other is derived:
 *   - missing text  ← signatureHtmlToText(signature_html)
 *   - missing html  ← escaped signature_text with newlines as <br>
 *
 * The returned `html` is the inner signature markup only — callers wrap it in
 * the `<div class="mcpemails-signature">…</div>` container.
 */
export function composeSignatureBlocks(
  inbox: SignatureInbox,
): { text: string; html: string } | null {
  if (inbox.signature_enabled === false) return null;

  const storedText = (inbox.signature_text ?? "").trim();
  const storedHtml = (inbox.signature_html ?? "").trim();
  if (!storedText && !storedHtml) return null;

  const text = storedText || signatureHtmlToText(storedHtml);
  // Belt-and-suspenders: scrub the stored HTML at send-time injection (covers
  // rows written before the tool-side sanitizer, or via any other write path)
  // before it is wrapped in the mcpemails-signature div. Idempotent on
  // already-clean HTML; https images and formatting survive.
  //
  // The *Safe variant on purpose: the sanitizer throws on output over 100KB,
  // and failing an entire send over an oversized signature would be a worse
  // outcome than sending without one. Every write path uses the throwing
  // version, so this only ever bites on rows written before that was true.
  const html = storedHtml
    ? sanitizeSignatureHtmlSafe(storedHtml)
    : escapeSignatureHtml(storedText).replace(/\n/g, "<br>\n");

  // Guard against a signature that strips down to nothing. The check has to be
  // on the html's CONTENT, not on the string being non-empty: the dashboard
  // editor persists `<p></p>` for an untouched signature field, which is a
  // non-empty string that renders as nothing. Treating it as a signature
  // appended a bare `-- ` delimiter followed by emptiness to every message.
  // An image-only signature (a logo with no text) is still a real signature,
  // so `<img>` counts as content alongside text.
  const htmlHasContent = signatureHtmlToText(html).trim().length > 0 ||
    /<img[\s>]/i.test(html);
  if (!text.trim() && !htmlHasContent) return null;

  return { text, html };
}

/** Options controlling signature application on a send. */
export interface ApplySignatureOptions {
  /**
   * Per-call override (Phase 1 wires this from the tool input). When explicitly
   * `false`, the signature is never applied. `undefined`/`true` → apply.
   */
  include_signature?: boolean;
}

/**
 * Apply the inbox signature to a NEW-MESSAGE body params object in place,
 * before `buildMimeMessage()` serializes it. Mutates and returns `params`.
 *
 * Rules:
 *   - No-op when `include_signature` is explicitly false, the signature is
 *     disabled, or both stored fields are empty.
 *   - Plain text: append `\n\n-- \n` + signature text (RFC 3676 delimiter:
 *     dash-dash-space-newline).
 *   - HTML: append the signature wrapped in
 *     `<div class="mcpemails-signature">…</div>`.
 *   - If only `textBody` was supplied but the inbox has any signature, an
 *     `htmlBody` is synthesized from the (escaped) plain body + rich signature
 *     so HTML clients render the rich sig — mirroring the multipart/alternative
 *     pair that buildMimeMessage emits whenever htmlBody is present.
 *
 * NOT IDEMPOTENT, on purpose: it appends what it is asked to append and has no
 * way to tell our own signature from a caller who typed the same words. Every
 * path that can run over an already-signed body has to say so with
 * `include_signature: false`. See `includeSignatureForSend`.
 *
 * PURE: reads only the passed objects; performs no I/O.
 */
export function applySignature<T extends { textBody: string; htmlBody?: string }>(
  params: T,
  inbox: SignatureInbox,
  opts: ApplySignatureOptions = {},
): T {
  if (opts.include_signature === false) return params;

  const sig = composeSignatureBlocks(inbox);
  if (!sig) return params;

  const sigTextBlock = `${SIGNATURE_TEXT_DELIMITER}${sig.text}`;
  const sigHtmlBlock = `\n<div class="${SIGNATURE_HTML_CLASS}">${sig.html}</div>`;

  if (params.htmlBody && params.htmlBody.trim()) {
    // Caller already supplied rich HTML — append to both parts so the
    // multipart/alternative pair stays consistent.
    params.htmlBody = `${params.htmlBody}${sigHtmlBlock}`;
    params.textBody = `${params.textBody}${sigTextBlock}`;
  } else {
    // Text-only send. Synthesize the HTML part from the ORIGINAL body (before
    // appending the text delimiter) so the signature appears exactly once in
    // each part, then sign the text part.
    params.htmlBody = `${plainTextBodyToHtml(params.textBody)}${sigHtmlBlock}`;
    params.textBody = `${params.textBody}${sigTextBlock}`;
  }

  return params;
}

// ---------------------------------------------------------------------------
// Held sends: who signs, and when
// ---------------------------------------------------------------------------

/** The parts of a send that go into the stored approval snapshot. */
export interface HeldSendSnapshotInput {
  inbox_id: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  attachments: Array<{ filename: string; mime_type: string; data: string }>;
  replyTo?: string;
}

/**
 * The payload `email_send` stores when an inbox has `send_approval_required`.
 *
 * Built here rather than inline at the call site because of the one key that is
 * easy to leave out and impossible to notice: `include_signature: false`.
 *
 * WHY IT IS ALWAYS FALSE. `email_send` runs `applySignature` BEFORE
 * `queueSendApproval`, so what is stored here is the FINAL body, signature
 * already in both parts. It is also what the reviewer is shown and what they
 * may edit. When they approve, the dispatcher re-runs `executeSendEmail` over
 * this snapshot; without this key that re-run would sign an already-signed body
 * and the recipient would get the signature twice. Recording the fact in the
 * snapshot (rather than only inferring it at dispatch) also makes the review
 * card honest: `buildOutboundEnvelope` reads `include_signature` to decide
 * whether to tell the reviewer "a signature will be appended", and for a held
 * `email_send` it will not be, because it is already in the body they read.
 *
 * It doubles as a fix for a quieter loss: a caller who passed
 * `include_signature: false` had that choice dropped on the floor by this
 * snapshot (it is built from the send params, not from the raw arguments), so
 * an approved send appended a signature the caller explicitly refused.
 *
 * Note this is NOT the shape reply/forward/draft_send/schedule_create store:
 * those queue their RAW ARGUMENTS, because threading, recipients and the
 * signature are all re-derived at dispatch time against the mailbox as it
 * stands then. `email_send` is the only operation whose snapshot is a
 * fully-composed message.
 */
export function heldSendSnapshot(
  input: HeldSendSnapshotInput,
): Record<string, unknown> {
  return {
    inbox_id: input.inbox_id,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    body: input.textBody,
    ...(input.htmlBody ? { html_body: input.htmlBody } : {}),
    ...(input.attachments.length ? { attachments: input.attachments } : {}),
    ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    include_signature: false,
  };
}

/**
 * Decide whether `email_send` should sign this call's body.
 *
 * Two ways the answer is "no", and the second one is the fix for a real bug:
 *
 *   1. the caller asked not to (`include_signature: false`), which is also how
 *      an approved snapshot describes itself (see `heldSendSnapshot`);
 *   2. this is the trusted dispatcher re-running an approved snapshot
 *      (`internalApprovalDispatch`). That marker cannot be supplied over MCP
 *      (index.ts sets it on a key it constructs itself), and the only operation
 *      that reaches `executeSendEmail` through it is `email_send`, whose
 *      snapshot was signed before it was stored. So on this path the body is
 *      always already signed, including for the pending rows written by an
 *      earlier deploy that carry no `include_signature` key at all.
 *
 * Clause 2 is deliberately redundant with clause 1 rather than replacing it:
 * clause 1 keeps the review card honest and survives an edit, clause 2 is the
 * last guard before mail goes out and covers snapshots this deploy did not
 * write. Neither is sufficient alone.
 *
 * Returns `undefined` (not `true`) for the sign-it case, because that is what
 * `ApplySignatureOptions` treats as "apply, per the inbox's own settings".
 */
export function includeSignatureForSend(
  args: Record<string, unknown>,
  internalApprovalDispatch?: boolean,
): boolean | undefined {
  if (args["include_signature"] === false) return false;
  if (internalApprovalDispatch === true) return false;
  return undefined;
}

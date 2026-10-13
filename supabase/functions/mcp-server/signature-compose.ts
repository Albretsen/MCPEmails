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
// Editing a signed body as plain text without losing the rich signature
// ---------------------------------------------------------------------------

/** LF line endings, no trailing blanks on any line: the form two texts are compared in. */
function comparableText(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

/**
 * Where `needle` sits in `hay` as whole lines, searching from the end; -1 when
 * it does not. With `endBy`, only a match that ends at or before that offset
 * counts.
 */
function lastWholeLineMatch(hay: string, needle: string, endBy = hay.length): number {
  let from = hay.length;
  while (from >= 0) {
    const at = hay.lastIndexOf(needle, from);
    if (at === -1) return -1;
    const end = at + needle.length;
    if ((end === hay.length || hay[end] === "\n") && end <= endBy) return at;
    from = at - 1;
  }
  return -1;
}

/**
 * Where quoted content starts in a body, or the body's length when it has none.
 *
 * The lines that open a quoted original: our own reply attribution ("On <date>,
 * <from> wrote:", index.ts#buildReplyTextBody), a `>` quote line, and the
 * blocks other mail clients write ("-----Original Message-----", an Outlook
 * "From:" line followed by "Sent:" or "Date:"). The signature the person's own
 * text carries sits before all of these, so a match inside the quote is the
 * quoted message's signature, not this one.
 */
function quoteStart(hay: string): number {
  const patterns = [
    /\nOn [^\n]{1,300} wrote:[ \t]*(?=\n|$)/,
    /\n>/,
    /\n-{2,}[ \t]*Original Message[ \t]*-{2,}/i,
    /\nFrom: [^\n]+\n(?:Sent|Date): /,
  ];
  let start = hay.length;
  for (const re of patterns) {
    const m = re.exec(hay);
    if (m && m.index < start) start = m.index;
  }
  return start;
}

/**
 * True when `text` still carries the inbox's signature text, untouched (or,
 * given the draft's HTML part, the signature text of the block it carries).
 *
 * "Untouched" is modulo line endings and trailing blanks, which a `<textarea>`
 * changes without the person doing anything, and needs whole lines: a signature
 * with two characters typed after it is an edited signature.
 */
export function bodyCarriesSignature(
  text: string,
  inbox: SignatureInbox,
  storedHtml?: string | null,
): boolean {
  // The text asked about is the stored one here, so it decides whether a
  // match without the delimiter line may count (see `splitAtSignature`).
  return splitAtSignature(text, inbox, storedHtml, text) !== null;
}

/**
 * The inner markup of the LAST `<div class="mcpemails-signature">` in an HTML
 * part, or null when there is none or its `div`s do not balance.
 *
 * This is the signature exactly as the stored draft carries it, which is not
 * always the inbox's signature of today: the person may have changed it on the
 * dashboard after the draft was written.
 */
export function storedSignatureBlockOf(html: string | null | undefined): string | null {
  if (typeof html !== "string") return null;
  const open = `<div class="${SIGNATURE_HTML_CLASS}">`;
  const at = html.lastIndexOf(open);
  if (at === -1) return null;
  const tag = /<(\/?)div\b[^>]*>/gi;
  tag.lastIndex = at + open.length;
  let depth = 1;
  for (let m = tag.exec(html); m !== null; m = tag.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(at + open.length, m.index);
  }
  return null;
}

/** One signature the edited text may still carry: its text half and the HTML to keep for it. */
interface SignatureCandidate {
  text: string;
  html: string;
}

function signatureCandidates(
  inbox: SignatureInbox,
  storedHtml: string | null | undefined,
): SignatureCandidate[] {
  const out: SignatureCandidate[] = [];
  // The draft's own block is re-sanitised before it is reused. It was written by
  // `applySignature` from sanitised markup, so this is idempotent for every
  // draft this server wrote; for one it did not write, it is the same rule
  // `composeSignatureBlocks` applies to a stored signature.
  const rawBlock = storedSignatureBlockOf(storedHtml);
  const block = rawBlock === null ? "" : sanitizeSignatureHtmlSafe(rawBlock.trim());
  const sig = composeSignatureBlocks(inbox);
  if (sig) {
    // The inbox's signature text, matched as the delimiter-plus-text
    // `applySignature` wrote. When the draft has its own block, that block is
    // what is kept: it is what the draft already showed, byte for byte, even if
    // the dashboard copy has been restyled since.
    out.push({ text: sig.text, html: block || sig.html });
  }
  if (block) {
    // The signature has changed on the dashboard since the draft was written,
    // so the text in the body is the OLD signature's text. The draft's block
    // still says what it was.
    const blockText = signatureHtmlToText(block);
    if (blockText) out.push({ text: blockText, html: block });
  }
  return out;
}

/** True when a text carries the `-- ` signature delimiter as a line of its own. */
function hasDelimiterLine(text: string): boolean {
  return /(^|\n)--(\n|$)/.test(comparableText(text));
}

/**
 * Where the edited `text` is split into the person's words and the signature,
 * or null when it no longer carries an untouched signature.
 *
 * ── A MATCH WITHOUT THE DELIMITER LINE (review 2 of 2026-10-13) ────────────
 * `applySignature` writes `-- ` then the signature, and a match on both is the
 * signature. A match on the signature lines ALONE exists for Outlook, which
 * hands the text part back derived from the HTML, with no delimiter line. But
 * for a one-line signature ("Asgeir") the bare match is any line that says the
 * same thing: a person who deleted `-- \nAsgeir` and signed off "Thanks,\nAsgeir"
 * got the rich signature block put back into the HTML part. So the bare match
 * counts only when the draft's STORED text (`storedText`) had no delimiter
 * line either, which is the Outlook shape; a stored text that had one tells us
 * that removing it removed the signature. When the stored text is not known,
 * only a signature of more than one line may match bare: two whole lines
 * repeated verbatim are the signature, one is just as likely a sign-off.
 */
function splitAtSignature(
  text: string,
  inbox: SignatureInbox,
  storedHtml?: string | null,
  storedText?: string | null,
): { before: string; after: string; html: string } | null {
  // A leading newline so a body that IS the signature still has a line break
  // in front of its delimiter to match on.
  const hay = `\n${comparableText(text)}`;
  // The match nearest the quote, but outside it: a reply that quotes a message
  // carrying the same signature has it twice, and the LAST one is in the quote
  // (review of 2026-10-13). Only when nothing matches before the quote does a
  // match inside it count, which is what this did before.
  const quoted = quoteStart(hay);
  const candidates = signatureCandidates(inbox, storedHtml);
  for (const endBy of quoted < hay.length ? [quoted, hay.length] : [hay.length]) {
    for (const candidate of candidates) {
      const sigText = comparableText(candidate.text).trim();
      if (!sigText) continue;
      // With the delimiter `applySignature` writes ("-- " loses its space
      // above), then without it: a provider that hands the text back derived
      // from HTML (Outlook) has no delimiter line.
      const bareAllowed = typeof storedText === "string"
        ? !hasDelimiterLine(storedText)
        : sigText.includes("\n");
      const needles = bareAllowed ? [`\n--\n${sigText}`, `\n${sigText}`] : [`\n--\n${sigText}`];
      for (const needle of needles) {
        const at = lastWholeLineMatch(hay, needle, endBy);
        if (at === -1) continue;
        return {
          before: hay.slice(0, at).replace(/^\n+|\n+$/g, ""),
          after: hay.slice(at + needle.length).replace(/^\n+/, ""),
          html: candidate.html,
        };
      }
    }
  }
  return null;
}

/**
 * The HTML part for a plain-text body a person just edited, keeping the rich
 * signature. Null when the body no longer carries an untouched signature.
 *
 * The draft editor is a plain-text surface over a message whose HTML part ends
 * in the inbox's formatted signature (logo, links, a table). Regenerating the
 * whole HTML part from the edited text turned that signature into its text
 * lines, with the `-- ` delimiter as a literal line of HTML (QA 2026-10-13).
 * Here the text is split at the signature instead: what the person wrote is
 * escaped by `plainTextBodyToHtml` as before, and the signature is the draft's
 * own stored signature block (else the inbox's signature HTML) in the same
 * wrapper `applySignature` writes, so the result is the message
 * `applySignature` would have built for the new text. The delimiter is a
 * plain-text convention and never reaches the HTML.
 *
 * `storedHtml` is the draft's current HTML part. It supplies the block to keep,
 * and it lets a draft whose signature was changed on the dashboard since it was
 * written keep the signature it has. `storedText` is the draft's current text
 * part: whether IT had a delimiter line decides whether the edited text may
 * match the signature without one (`splitAtSignature`).
 *
 * Text after the signature (the quoted original of a reply) follows it,
 * escaped.
 *
 * NULL MEANS THE FORMATTING CANNOT BE KEPT. The person edited the signature
 * lines themselves, so no stored markup says what they typed. The caller decides
 * what to write instead; the draft editor writes no HTML part at all and tells
 * the card so (`body.formatting_removed`).
 */
export function rebuildHtmlKeepingSignature(
  text: string,
  inbox: SignatureInbox,
  storedHtml?: string | null,
  storedText?: string | null,
): string | null {
  const split = splitAtSignature(text, inbox, storedHtml, storedText);
  if (!split) return null;
  const sigHtmlBlock = `\n<div class="${SIGNATURE_HTML_CLASS}">${split.html}</div>`;
  const tail = split.after ? `\n<br>\n${plainTextBodyToHtml(split.after)}` : "";
  return `${plainTextBodyToHtml(split.before)}${sigHtmlBlock}${tail}`;
}

/** True when an HTML part carries our signature wrapper. */
export function htmlCarriesSignatureBlock(html: string | null | undefined): boolean {
  return typeof html === "string" && html.includes(`class="${SIGNATURE_HTML_CLASS}"`);
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

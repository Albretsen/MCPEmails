// ---------------------------------------------------------------------------
// quoted-reply: where the quoted original of a reply starts, in a draft's text
// part and in its HTML part
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS (draft card release review, 2026-10-17). A reply draft's text
// part is `<message>\n\n-- \n<signature>\n\nOn <date>, <from> wrote:\n> ...`
// (index.ts#buildReplyTextBody), and the card split it at the LAST `-- ` line
// and called everything after it the signature. So the Signature row read
// "Asgeir Albretsen + 17 more lines", its Edit box held the whole quoted
// original, and editing "the signature" could delete or mangle the thread. The
// card now shows the quote as a read-only section of its own, and needs to be
// told where it starts: `body.quoted.line` in the §8 envelope.
//
// It is also what lets a save keep a reply's quoted HTML. A body edit
// regenerates the HTML part from the text (mcp-app-drafts.ts#applyDraftPatch),
// which turned Gmail's or Outlook's quoted original into escaped `> ` lines.
// When the text's quote is untouched by the edit and the HTML part has a
// recognisable quote block, that block is kept byte for byte instead.
//
// Detection is deliberately conservative. Calling a person's own words "quoted"
// makes them read-only in the card, which is worse than leaving a quote in the
// editable box (the old behaviour). So an attribution line only counts when
// every line after it is a `>` line, and a bare `>` block only when it runs to
// the end of the text: a draft that answers inline, between quoted lines, has
// no quote as far as this module is concerned and edits exactly as before.
//
// PURE: string work only, so it is tested without a mailbox.
// ---------------------------------------------------------------------------

/** The words mail clients write before the original, as one alternation. */
const ATTRIBUTION_LEAD = "(?:On|Le|Am|El|Il|Op|Den|På|Em)";
const ATTRIBUTION_VERB =
  "(?:wrote|a écrit|schrieb|escribió|ha scritto|schreef|skrev|escreveu)";

/**
 * "On Mon, 7 Sep 2026 17:32:55 +0000, Asgeir <a@x.example> wrote:" and the
 * other languages' shapes ("Den 7. sep. 2026 kl. 17:32 skrev ...:", "Am ...
 * schrieb ...:"). Gmail wraps a long one over two lines, which the caller
 * handles by trying the line joined with the next one.
 */
const ATTRIBUTION = new RegExp(
  `^\\s*${ATTRIBUTION_LEAD}\\s.{1,400}?${ATTRIBUTION_VERB}(?:\\s.{0,80})?\\s?:\\s*$`,
  "i",
);

/** The opening of an attribution, for one Gmail wrapped over two lines. */
const ATTRIBUTION_OPENING = new RegExp(`^\\s*${ATTRIBUTION_LEAD}\\s`, "i");

/** "-----Original Message-----", Outlook's plain-text separator, in a few languages. */
const ORIGINAL_MESSAGE =
  /^\s*-{2,}\s*(?:Original Message|Opprinnelig melding|Opprinneleg melding|Ursprüngliche Nachricht|Message d'origine|Mensaje original|Messaggio originale|Originalmeddelande|Oorspronkelijk bericht)\s*-{2,}\s*$/i;

/** The first line of Outlook's header block ("From: Dana <d@x.example>"). */
const HEADER_FROM = /^\s*\*?(?:From|Fra|Von|De|Från|Van)\*?:\s*\S/i;
/** A date line in that block. */
const HEADER_DATE = /^\s*\*?(?:Sent|Date|Sendt|Dato|Gesendet|Datum|Envoyé|Enviado|Skickat)\*?:\s*\S/i;
/** A subject line in that block. */
const HEADER_SUBJECT = /^\s*\*?(?:Subject|Emne|Betreff|Objet|Asunto|Ämne|Onderwerp)\*?:/i;
/** The rule Outlook draws above that block. */
const UNDERSCORE_RULE = /^\s*_{8,}\s*$/;

/** One line of a text, without its `\n` and without a trailing `\r`. */
function linesOf(text: string): string[] {
  return text.split("\n").map((line) => line.replace(/\r$/, ""));
}

const isBlank = (line: string) => line.trim().length === 0;
const isQuoteLine = (line: string) => /^\s*>/.test(line);

/** True when every non-blank line from `from` on is a `>` line, and there is at least one. */
function quoteLinesToEnd(lines: string[], from: number): boolean {
  let any = false;
  for (let i = from; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    if (!isQuoteLine(lines[i])) return false;
    any = true;
  }
  return any;
}

/** True when anything but blank lines follows `from`. */
function contentAfter(lines: string[], from: number): boolean {
  for (let i = from; i < lines.length; i++) if (!isBlank(lines[i])) return true;
  return false;
}

/**
 * The line the quoted original starts on (0-based, counted in `\n`), or -1
 * when the text has none.
 *
 * Recognised, earliest first:
 *   - an attribution line ("On <date>, <name> wrote:", on one line or wrapped
 *     over two) followed by `>` lines to the end;
 *   - "-----Original Message-----" with something after it;
 *   - Outlook's header block: a "From:" line with a "Sent:"/"Date:" line and a
 *     "Subject:" line within the next six, starting at the underscore rule
 *     above it when there is one;
 *   - a block of `>` lines that runs to the end of the text.
 *
 * Counted in lines, not characters, because that is the unit that survives the
 * trip to the card: the card strips invisible characters from every string at
 * its boundary (sanitize.ts#neutralizeText), which moves character offsets but
 * never removes a `\n`.
 */
export function quotedTextLine(text: string | null | undefined): number {
  if (typeof text !== "string" || text.length === 0) return -1;
  const lines = linesOf(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) continue;

    if (ATTRIBUTION.test(line) && quoteLinesToEnd(lines, i + 1)) return i;
    if (
      i + 1 < lines.length && ATTRIBUTION_OPENING.test(line) &&
      ATTRIBUTION.test(`${line} ${lines[i + 1].trim()}`) && quoteLinesToEnd(lines, i + 2)
    ) {
      return i;
    }

    if (ORIGINAL_MESSAGE.test(line) && contentAfter(lines, i + 1)) return i;

    if (HEADER_FROM.test(line)) {
      const window = lines.slice(i + 1, i + 7);
      if (window.some((l) => HEADER_DATE.test(l)) && window.some((l) => HEADER_SUBJECT.test(l))) {
        return i > 0 && UNDERSCORE_RULE.test(lines[i - 1]) ? i - 1 : i;
      }
    }

    if (isQuoteLine(line) && quoteLinesToEnd(lines, i)) return i;
  }
  return -1;
}

/** The character offset of line `line` (see `quotedTextLine`) in `text`. */
export function offsetOfLine(text: string, line: number): number {
  let at = 0;
  for (let i = 0; i < line; i++) {
    const nl = text.indexOf("\n", at);
    if (nl === -1) return text.length;
    at = nl + 1;
  }
  return at;
}

/**
 * The text split at its quoted original: `head + quote === text`, byte for
 * byte. The blank lines between the two belong to the quote, so the head ends
 * where the person's own words (and signature) do. Null when there is no quote.
 */
export function splitQuotedText(
  text: string | null | undefined,
): { head: string; quote: string } | null {
  if (typeof text !== "string") return null;
  const line = quotedTextLine(text);
  if (line < 0) return null;
  let at = offsetOfLine(text, line);
  // Back over the blank lines above the quote.
  while (at > 0) {
    const prevEnd = at - 1; // the "\n" that ends the previous line
    const prevStart = text.lastIndexOf("\n", prevEnd - 1) + 1;
    if (!isBlank(text.slice(prevStart, prevEnd))) break;
    at = prevStart;
  }
  // ...and the line break that ends the last line of the head, so the head
  // does not end in a stray newline.
  if (at > 0 && text[at - 1] === "\n") at -= text[at - 2] === "\r" ? 2 : 1;
  return { head: text.slice(0, at), quote: text.slice(at) };
}

/**
 * Where a quoted original starts in an HTML part, or -1.
 *
 * Only the wrappers mail clients put around a quote they wrote are recognised,
 * never a bare `<blockquote>`, which a person may use in their own message:
 * Gmail's `gmail_quote`, Apple Mail's and Thunderbird's `<blockquote
 * type="cite">` (and Thunderbird's `moz-cite-prefix` line above it), Outlook's
 * `divRplyFwdMsg` / `appendonsend` / `stopSpelling`, and Yahoo's
 * `yahoo_quoted`. The earliest one wins.
 */
export function quotedHtmlStart(html: string | null | undefined): number {
  if (typeof html !== "string" || html.length === 0) return -1;
  const markers = [
    /<(?:div|blockquote)\b[^>]*\bclass\s*=\s*["'][^"']*\bgmail_quote/i,
    /<blockquote\b[^>]*\btype\s*=\s*["']?cite\b/i,
    /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bmoz-cite-prefix\b/i,
    /<div\b[^>]*\bid\s*=\s*["']?(?:divRplyFwdMsg|appendonsend)\b/i,
    /<hr\b[^>]*\bid\s*=\s*["']?stopSpelling\b/i,
    /<div\b[^>]*\bclass\s*=\s*["'][^"']*\byahoo_quoted\b/i,
  ];
  let start = -1;
  for (const re of markers) {
    const m = re.exec(html);
    if (m && (start === -1 || m.index < start)) start = m.index;
  }
  return start;
}

/** LF line endings and no trailing blanks: the form two quotes are compared in. */
export function comparableQuote(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/** "17:32", "5:32 PM", "17.32": a time of day, which every attribution's date has. */
const TIME_OF_DAY = /\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s?[AaPp]\.?[Mm]\.?)?/;

/**
 * Who a reply draft answers, read off the attribution line above its quoted
 * original, or null when there is none this can read with confidence.
 *
 * WHY (live claude.ai test, 2026-10-19). The card's "Replying to Dana ·
 * <subject>" line comes from `draft.in_reply_to`, which the server could fill
 * on the reply path only, where it has just fetched the original. Every later
 * envelope (an update, a read, a save) answered null, so the newer card a
 * `draft{action:"update"}` mounts had no such line, while the older card above
 * it still did. The stored draft does say who it answers: the attribution this
 * server writes is `On <Date header>, <From header> wrote:`
 * (index.ts#buildReplyTextBody), from the same From the reply path shows.
 *
 * Two shapes, tried in order:
 *   - ours: `<date>, <from>`. The date holds commas ("Mon, 7 Sep 2026 ..."),
 *     so the split is at the first ", " whose left side has a time of day.
 *   - Gmail's: `<date> at <time> <from>`, no comma before the sender.
 * Anything else (another client's wording, an Outlook header block) is null,
 * and the card then says "Replying to an earlier message".
 */
export function attributionSender(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const line = quotedTextLine(text);
  if (line < 0) return null;
  const lines = linesOf(text);
  const first = lines[line] ?? "";
  const joined = ATTRIBUTION.test(first)
    ? first
    : line + 1 < lines.length && ATTRIBUTION.test(`${first} ${lines[line + 1].trim()}`)
    ? `${first} ${lines[line + 1].trim()}`
    : null;
  if (joined === null) return null;
  const inner = joined
    .replace(new RegExp(`^\\s*${ATTRIBUTION_LEAD}\\s+`, "i"), "")
    .replace(new RegExp(`\\s*${ATTRIBUTION_VERB}\\s*:\\s*$`, "i"), "")
    .trim();
  const sane = (s: string) => {
    const t = s.trim();
    return t.length > 0 && t.length <= 300 ? t : null;
  };
  for (let at = inner.indexOf(", "); at !== -1; at = inner.indexOf(", ", at + 2)) {
    if (TIME_OF_DAY.test(inner.slice(0, at))) return sane(inner.slice(at + 2));
  }
  const afterTime = new RegExp(`${TIME_OF_DAY.source}\\s+(.+)$`).exec(inner);
  return afterTime ? sane(afterTime[1]) : null;
}

/**
 * The body a `draft{action:"update"}` writes when it is given a new `body`,
 * keeping a reply's quoted original (live re-test, 2026-10-17).
 *
 * WHY. A new body replaced the whole text, so an update to a reply dropped the
 * thread it answers. Claude worked around it by sending the quote back itself,
 * copied from a read, with the automatic signature turned off so it would not
 * land under the quote. The card's own saves never had this problem: they hand
 * the quote back byte for byte (mcp-app-drafts.ts#applyDraftPatch).
 *
 * Three cases, by what the caller's body holds:
 *   - no quote of its own, and none of the stored one's opening line: the
 *     stored quote follows the new (signed) text, and its stored HTML block
 *     follows the HTML part when there is one. `quoteKept: true`.
 *   - a quote of its own (Claude sent it back, as above): it is NOT doubled.
 *     With no caller HTML, the signature goes above that quote rather than
 *     under it, and the HTML part ends in the stored quote block when the two
 *     quotes are the same text.
 *   - the stored draft has no quote: exactly what it did before.
 *
 * `sign` is `applySignature` with the caller's options and `toHtml` is
 * `plainTextBodyToHtml`, passed in so this module stays string work only.
 */
export function bodyKeepingQuote(
  body: string,
  htmlBody: string | undefined,
  stored: { text?: string | null; html?: string | null } | null | undefined,
  sign: (p: { textBody: string; htmlBody?: string }) => { textBody: string; htmlBody?: string },
  toHtml: (text: string) => string,
): { textBody: string; htmlBody?: string; quoteKept: boolean; signed: boolean } {
  const storedSplit = splitQuotedText(stored?.text);
  const storedHtml = typeof stored?.html === "string" ? stored.html : "";
  const htmlAt = quotedHtmlStart(storedHtml);
  const storedQuoteHtml = htmlAt >= 0 ? storedHtml.slice(htmlAt) : "";
  const own = htmlBody === undefined ? splitQuotedText(body) : null;
  const dropLeadingBlanks = (t: string) => t.replace(/^(?:[ \t]*\r?\n)+/, "");

  let head = body;
  let tail = "";
  let tailHtml = "";
  let quoteKept = false;
  if (own) {
    head = own.head;
    tail = own.quote;
    tailHtml = storedSplit && storedQuoteHtml &&
        comparableQuote(own.quote) === comparableQuote(storedSplit.quote)
      ? storedQuoteHtml
      : toHtml(dropLeadingBlanks(own.quote));
  } else if (storedSplit && !alreadyQuotes(body, htmlBody, storedSplit.quote)) {
    // The stored text may be CRLF (a raw IMAP read); the caller's is not.
    tail = body.includes("\r") ? storedSplit.quote : storedSplit.quote.replace(/\r\n/g, "\n");
    tailHtml = storedQuoteHtml || toHtml(dropLeadingBlanks(tail));
    quoteKept = true;
  }

  const signed = sign({ textBody: head, ...(htmlBody !== undefined ? { htmlBody } : {}) });
  const wasSigned = signed.textBody !== head;
  if (!tail) return { ...signed, quoteKept: false, signed: wasSigned };
  // No HTML part (no signature, no caller HTML): one is written only to keep a
  // client's own quote block, which plain text would flatten.
  const html = signed.htmlBody !== undefined
    ? `${signed.htmlBody}\n${tailHtml}`
    : storedQuoteHtml && tailHtml === storedQuoteHtml
    ? `${toHtml(signed.textBody)}\n${tailHtml}`
    : undefined;
  return {
    textBody: signed.textBody + tail,
    ...(html !== undefined ? { htmlBody: html } : {}),
    quoteKept,
    signed: wasSigned,
  };
}

/**
 * True when the caller's body already carries the stored quote in some form
 * the line count above did not recognise (an HTML quote block, or the quote's
 * opening line as a line of the text), so carrying it would double it.
 */
function alreadyQuotes(body: string, htmlBody: string | undefined, quote: string): boolean {
  if (quotedHtmlStart(htmlBody) >= 0) return true;
  const opening = linesOf(quote).map((l) => l.trim()).find((l) => l.length > 0);
  if (!opening) return true;
  return linesOf(body).some((l) => l.trim() === opening);
}

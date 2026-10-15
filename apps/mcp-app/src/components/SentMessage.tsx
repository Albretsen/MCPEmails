import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Receipt as ReceiptData } from "../contract";
import type { EndedCopy, EndedField } from "../ended";
import { formatBytes, formatDateTime, splitBody, wordCount } from "../format";
import { copyLabel, Fields, HtmlBody, Notice, TextLink, useCopy } from "./ui";

/**
 * A draft that has ended (sent, or discarded), with the message still there to
 * read.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Pressing Send used to replace the whole editor with `Receipt`, which is one
 * line: "Sent." Everything the user had just written vanished from the screen
 * at the exact moment they most wanted to check it, and the only remaining copy
 * was in a Sent folder this card cannot open. Users said so, repeatedly.
 *
 * So the receipt is still the truth — the headline and the tone come from it —
 * and the message is kept underneath it, read-only.
 * `store.ts#carrySentDraft` is what puts the draft on the receipt envelope; this
 * component is what draws it.
 *
 * ── Show and Hide (2026-10-14) ──────────────────────────────────────────────
 * The same view now also serves a discard, and a card reopened after either:
 * the line it ends on stays one line, with "Show" on the right to open the
 * message again and "Hide" to fold it. Right after the person's own Send it
 * starts open, as it always has; everywhere else it starts folded, because a
 * discard is the person asking for the draft to go away and a reopened chat
 * should look as calm as it did. What it shows is `ended.ts#EndedCopy`, which
 * is only ever a copy the card can stand behind, and App.tsx offers this view
 * only when there is one. A discarded copy says which of its fields were never
 * saved, and offers "Copy text": the reason to open it is usually to keep the
 * words.
 *
 * ── Read-only, and visibly so ───────────────────────────────────────────────
 * Not the editor with `disabled` inputs: a greyed-out textarea beside a Save
 * button that can never work reads as a bug, and the draft is genuinely gone at
 * the provider, so there is nothing an input could write to. Static text, the
 * same label gutter as every other card so it still reads as one product, and
 * no buttons at all beyond the ones that only look (expand, copy).
 *
 * ── No dashboard link (2026-10-15) ──────────────────────────────────────────
 * "Open in dashboard" used to sit here. It opened the dashboard's home page,
 * which has no view of a draft or a sent message, while the label promised
 * this message. The receipt's `dashboard_url` is still read by `Receipt`,
 * which only links to a page that is about the receipt (Receipt.tsx).
 *
 * ── How much of it ──────────────────────────────────────────────────────────
 * Inline, the body is clamped to three lines (`.preview`, the same clamp the
 * outbound card uses) with one link to open the rest in place. An inline card
 * sits in the middle of a conversation and must not turn a sent message into a
 * screenful of scrollback. In fullscreen the message is the point, so it is all
 * there without asking.
 */
export interface SentMessageProps {
  receipt: ReceiptData;
  copy: EndedCopy;
  /** Open on arrival: only right after the person's own Send in this card. */
  startOpen: boolean;
  fullscreen: boolean;
  canExpand: boolean;
  setFullscreen: (on: boolean) => void;
}

/** "3 attachments: q3.pdf 180 KB, …". The card cannot open them. */
function attachmentLine(c: EndedCopy, fullscreen: boolean): string | null {
  const all = c.attachments ?? [];
  const count = Math.max(c.attachment_count ?? 0, all.length);
  if (count === 0) return null;
  const shown = all.slice(0, fullscreen ? 8 : 3);
  const names = shown
    .map((a) => `${a.filename || "(unnamed)"} ${formatBytes(a.size_bytes)}`)
    .join(", ");
  const rest = count - shown.length;
  return `${count} attachment${count === 1 ? "" : "s"}${names ? `: ${names}` : ""}${
    rest > 0 ? `${names ? "," : ":"} +${rest} more` : ""
  }`;
}

/**
 * "dana@x.example · +2 more · 1 cc". Deliberately not `summarizeRecipients`:
 * that one takes a bcc COUNT because §2 hides bcc addresses from a reviewer,
 * and this is the user's own draft, where the addresses were on screen a second
 * ago and hiding them now would read as data loss rather than as discretion.
 */
function recipientSummary(c: EndedCopy): { primary: string; extra: string } {
  const primary = c.to[0] ?? c.cc[0] ?? c.bcc[0] ?? "(no recipient)";
  const bits: string[] = [];
  const restTo = Math.max(0, c.to.length - 1);
  if (restTo > 0) bits.push(`+${restTo} more`);
  if (c.cc.length > 0) bits.push(`${c.cc.length} cc`);
  if (c.bcc.length > 0) bits.push(`${c.bcc.length} bcc`);
  return { primary, extra: bits.join(" · ") };
}

const FIELD_WORDS: Record<EndedField, string> = {
  to: "To",
  cc: "Cc",
  bcc: "Bcc",
  subject: "the subject",
  body: "the message",
};

/** "the subject and the message", "To, Cc and the message". */
function fieldList(fields: EndedField[]): string {
  const words = fields.map((f) => FIELD_WORDS[f]);
  return words.length <= 1
    ? words.join("")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * The one sentence over a copy that is not simply "what was sent": whose copy
 * it is, and what in it was never saved.
 */
function copyLabelLine(c: EndedCopy): string | null {
  const unsaved = c.unsaved?.length
    ? ` It includes changes that were never saved: ${fieldList(c.unsaved)}.`
    : "";
  switch (c.how) {
    case "discarded":
      return `This is the text it had when it was discarded.${unsaved}`;
    case "gone":
      return `This is the text this card had.${unsaved}`;
    case "sent_elsewhere":
      return `This is the text this card had. What was sent may differ.${unsaved}`;
    default:
      return null;
  }
}

let seq = 0;

export function SentMessage(props: SentMessageProps) {
  const { receipt: r, copy: c, fullscreen } = props;
  const [open, setOpen] = useState(props.startOpen);
  // Inline only. Fullscreen never clamps, so it never needs the toggle.
  const [expanded, setExpanded] = useState(false);
  const [showHtml, setShowHtml] = useState(false);
  const { copied, copy } = useCopy();
  const regionId = useRef(`ended-${++seq}`).current;
  const bodyRef = useRef<HTMLParagraphElement>(null);

  // Show and Hide are one button that keeps its place, but the header around
  // it is rebuilt, so focus is put back on it explicitly after a toggle.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    toggleRef.current?.focus();
  }, [open]);
  const toggle = () => {
    refocus.current = true;
    // Folding a message in fullscreen leaves one line on an empty page.
    if (open && fullscreen) props.setFullscreen(false);
    setOpen(!open);
  };

  const bodyText = c.body_text;
  const hasHtml = !!c.body_html;
  const departed = c.how === "sent" || c.how === "scheduled";
  const scheduled = r.outcome === "scheduled";
  const tone = r.outcome === "sent" || r.outcome === "scheduled" ? "success" : "neutral";
  const fallback = scheduled ? "Scheduled" : r.outcome === "sent" ? "Sent" : "Draft discarded.";
  const headline = r.headline?.trim() || fallback;
  // The time is formatted here and not by the server, which has no timezone
  // to format it in. `sent_at` is a published key of the draft-send payload,
  // so this costs no new field. A discard shows none, and no sender either:
  // the headline already says what happened, and the label line says whose
  // text it is, so the header stays one line with Show/Hide where it was.
  const when = departed ? formatDateTime(c.sent_at) : "";
  const recipients = recipientSummary(c);
  const attachments = attachmentLine(c, fullscreen);
  const detail = r.detail?.trim() || null;
  const label = copyLabelLine(c);

  const toggleLink = (
    <TextLink
      btnRef={toggleRef}
      expanded={open}
      controls={open ? regionId : undefined}
      title={open ? "Fold this back to one line" : departed ? "Show the message" : "Show the text it had"}
      onClick={toggle}
    >
      {open ? "Hide" : "Show"}
    </TextLink>
  );

  // ---- folded: the one line, exactly as calm as `Receipt`, plus Show -------

  if (!open) {
    return (
      <>
        <div class="hdr">
          <div class="hdr-l">
            <span class="dot" data-tone={tone} aria-hidden="true" />
            <b>{headline}</b>
          </div>
          <div class="hdr-r">
            {toggleLink}
          </div>
        </div>
        {detail && <p class="line">{detail}</p>}
      </>
    );
  }

  const header = (
    <div class="hdr">
      <div class="hdr-l">
        <span class="dot" data-tone={tone} aria-hidden="true" />
        <b>{headline}</b>
        {departed && c.from && <span class="muted">{c.from}</span>}
      </div>
      <div class="hdr-r">
        {when && (
          <span class="muted">
            {scheduled ? "Sending" : "Sent"} {when}
          </span>
        )}
        {fullscreen ? (
          <TextLink onClick={() => props.setFullscreen(false)}>Collapse</TextLink>
        ) : props.canExpand ? (
          <TextLink
            onClick={() => props.setFullscreen(true)}
            title="Read the whole message"
          >
            Expand
          </TextLink>
        ) : null}
        {toggleLink}
      </div>
    </div>
  );

  /**
   * The footer of both layouts: where the message went. Nothing here acts:
   * the draft is gone at the provider, so there is nothing left to refresh,
   * save, or discard.
   */
  const footer = (
    <>
      {attachments && <p class="line">{attachments}</p>}
      {detail && <p class="line">{detail}</p>}
      {c.truncated && (
        <Notice tone="warning">
          {departed
            ? "This is a clipped copy of the message. The full text is in the mailbox it was sent from."
            : "This is a clipped copy of the text. The card never had all of it."}
        </Notice>
      )}
      <p class="line">
        {/* The message, not the message plus the signature — the same count the
            editor showed a second ago, so the two views do not disagree about
            how long what you wrote was. */}
        {[`${wordCount(splitBody(bodyText).message)} words`, c.provider]
          .filter((s): s is string => !!s)
          .join(" · ")}
      </p>
    </>
  );

  const bodyBlock = (full: boolean) =>
    showHtml && hasHtml ? (
      <HtmlBody html={c.body_html as string} />
    ) : (
      <p class={full ? "body-full" : "preview"} ref={bodyRef}>
        {bodyText || "(empty message)"}
      </p>
    );

  /** Put the subject and text on the clipboard, or select the text. */
  const copyText = () => {
    const text = c.subject ? `${c.subject}\n\n${bodyText}` : bodyText;
    copy(text, () => {
      const el = bodyRef.current;
      const sel = window.getSelection?.();
      if (el && sel) sel.selectAllChildren(el);
    });
  };

  /** Independent toggles, one line, and only the ones that apply. */
  const bodyLinks = (offerExpand: boolean) => {
    const links = [
      offerExpand ? (
        <TextLink key="more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show full message"}
        </TextLink>
      ) : null,
      hasHtml ? (
        <TextLink
          key="html"
          onClick={() => setShowHtml(!showHtml)}
          title={
            showHtml
              ? "The plain-text version"
              : "The formatted version, as it was sent"
          }
        >
          {showHtml ? "Show plain text" : "Show formatting"}
        </TextLink>
      ) : null,
      // Not for a send: the message is in the Sent folder. A discarded text
      // is in no folder at all, and keeping it is why it was opened.
      !departed ? (
        <TextLink key="copy" onClick={copyText}>
          {copyLabel(copied)}
        </TextLink>
      ) : null,
    ].filter(Boolean);
    if (links.length === 0) return null;
    return <p class="line links">{links}</p>;
  };

  // ---- inline -------------------------------------------------------------

  if (!fullscreen) {
    // Only offer "Show full message" when there is more to show. A three-line
    // note with a link promising more under it is a link to nothing.
    const clipped = bodyText.split("\n").length > 3 || bodyText.length > 220;
    return (
      <>
        {header}
        <div class="stack" id={regionId}>
          {label && <p class="line">{label}</p>}
          <div class="tight">
            <div class="row">
              <span class="lbl">To</span>
              <span class="val">
                {recipients.primary}
                {recipients.extra && <span class="muted"> · {recipients.extra}</span>}
              </span>
            </div>
            <h2 class="subject">{c.subject || "(no subject)"}</h2>
          </div>
          {bodyBlock(expanded || showHtml)}
          {bodyLinks(clipped && !showHtml)}
          {footer}
        </div>
      </>
    );
  }

  // ---- fullscreen ---------------------------------------------------------

  const rows: Array<[string, string]> = [
    ["To", c.to.join(", ") || "(none)"],
    ...(c.cc.length ? ([["Cc", c.cc.join(", ")]] as Array<[string, string]>) : []),
    ...(c.bcc.length ? ([["Bcc", c.bcc.join(", ")]] as Array<[string, string]>) : []),
    ...(c.from ? ([["From", c.from]] as Array<[string, string]>) : []),
  ];

  return (
    <>
      {header}
      <div class="stack" id={regionId}>
        {label && <p class="line">{label}</p>}
        <h2 class="subject">{c.subject || "(no subject)"}</h2>
        <Fields rows={rows} />
        {bodyBlock(true)}
        {bodyLinks(false)}
        {footer}
      </div>
    </>
  );
}

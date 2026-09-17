import { useState } from "preact/hooks";
import type {
  DraftEditorData,
  Provider,
  Receipt as ReceiptData,
} from "../contract";
import { formatBytes, formatDateTime, splitBody, wordCount } from "../format";
import { Fields, HtmlBody, Notice, TextLink } from "./ui";

/**
 * A draft that has just been sent, still showing the message.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Pressing Send used to replace the whole editor with `Receipt`, which is one
 * line: "Sent." Everything the user had just written vanished from the screen
 * at the exact moment they most wanted to check it, and the only remaining copy
 * was in a Sent folder this card cannot open. Users said so, repeatedly.
 *
 * So the receipt is still the truth — the headline, the tone and the dashboard
 * link all come from it — and the message is kept underneath it, read-only.
 * `store.ts#carrySentDraft` is what puts the draft on the receipt envelope; this
 * component is what draws it.
 *
 * ── Read-only, and visibly so ───────────────────────────────────────────────
 * Not the editor with `disabled` inputs: a greyed-out textarea beside a Save
 * button that can never work reads as a bug, and the draft is genuinely gone at
 * the provider, so there is nothing an input could write to. Static text, the
 * same label gutter as every other card so it still reads as one product, and
 * no buttons at all beyond the two that only look (expand, dashboard).
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
  draft: DraftEditorData;
  provider?: Provider;
  /** Top-level `sent_at` from the draft-send payload. See contract §8. */
  sentAt?: string | null;
  fullscreen: boolean;
  canExpand: boolean;
  busy: string | null;
  onOpenDashboard: () => void;
  setFullscreen: (on: boolean) => void;
}

/** "3 attachments: q3.pdf 180 KB, …". The card cannot open them. */
function attachmentLine(d: DraftEditorData, fullscreen: boolean): string | null {
  const all = d.attachments ?? [];
  if (all.length === 0) return null;
  const shown = all.slice(0, fullscreen ? 8 : 3);
  const names = shown
    .map((a) => `${a.filename || "(unnamed)"} ${formatBytes(a.size_bytes)}`)
    .join(", ");
  const rest = all.length - shown.length;
  return `${all.length} attachment${all.length === 1 ? "" : "s"}: ${names}${
    rest > 0 ? `, +${rest} more` : ""
  }`;
}

/**
 * "dana@x.example · +2 more · 1 cc". Deliberately not `summarizeRecipients`:
 * that one takes a bcc COUNT because §2 hides bcc addresses from a reviewer,
 * and this is the user's own draft, where the addresses were on screen a second
 * ago and hiding them now would read as data loss rather than as discretion.
 */
function recipientSummary(d: DraftEditorData): { primary: string; extra: string } {
  const to = d.recipients?.to ?? [];
  const cc = d.recipients?.cc ?? [];
  const bcc = d.recipients?.bcc ?? [];
  const primary = to[0] ?? cc[0] ?? bcc[0] ?? "(no recipient)";
  const bits: string[] = [];
  const restTo = Math.max(0, to.length - 1);
  if (restTo > 0) bits.push(`+${restTo} more`);
  if (cc.length > 0) bits.push(`${cc.length} cc`);
  if (bcc.length > 0) bits.push(`${bcc.length} bcc`);
  return { primary, extra: bits.join(" · ") };
}

export function SentMessage(props: SentMessageProps) {
  const { receipt: r, draft: d, fullscreen } = props;
  // Inline only. Fullscreen never clamps, so it never needs the toggle.
  const [expanded, setExpanded] = useState(false);
  const [showHtml, setShowHtml] = useState(false);

  const bodyText = d.body?.text ?? "";
  const hasHtml = !!d.body?.html;
  const scheduled = r.outcome === "scheduled";
  const headline =
    r.headline?.trim() || (scheduled ? "Scheduled" : "Sent");
  const when = formatDateTime(props.sentAt);
  const from = d.identity?.email_address ?? null;
  const recipients = recipientSummary(d);
  const attachments = attachmentLine(d, fullscreen);
  const detail = r.detail?.trim() || null;

  const header = (
    <div class="hdr">
      <div class="hdr-l">
        <span class="dot" data-tone="success" aria-hidden="true" />
        <b>{headline}</b>
        {from && <span class="muted">{from}</span>}
      </div>
      <div class="hdr-r">
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
        {/* The time is formatted here and not by the server, which has no
            timezone to format it in. `sent_at` is a published key of the
            draft-send payload, so this costs no new field. */}
        {when && (
          <span class="muted">
            {scheduled ? "Sending" : "Sent"} {when}
          </span>
        )}
      </div>
    </div>
  );

  /**
   * The footer of both layouts: where the message went, and the way to the
   * copy that outlives this card. The dashboard link is the ONLY thing here
   * that is not a fact already on screen — the draft is gone at the provider,
   * so there is nothing left to refresh, save, or discard.
   */
  const footer = (
    <>
      {attachments && <p class="line">{attachments}</p>}
      {detail && <p class="line">{detail}</p>}
      {d.body?.truncated && (
        <Notice tone="warning">
          This is a clipped copy of the message. The full text is in the mailbox
          it was sent from.
        </Notice>
      )}
      <p class="line">
        {/* The message, not the message plus the signature — the same count the
            editor showed a second ago, so the two views do not disagree about
            how long what you wrote was. */}
        {[`${wordCount(splitBody(bodyText).message)} words`, props.provider?.label]
          .filter((s): s is string => !!s)
          .join(" · ")}
        {r.dashboard_url && (
          <>
            {" · "}
            <TextLink
              disabled={props.busy === "dashboard"}
              onClick={props.onOpenDashboard}
            >
              Open in dashboard
            </TextLink>
          </>
        )}
      </p>
    </>
  );

  const bodyBlock = (full: boolean) =>
    showHtml && hasHtml ? (
      <HtmlBody html={d.body?.html as string} />
    ) : full ? (
      <p class="body-full">{bodyText || "(empty message)"}</p>
    ) : (
      <p class="preview">{bodyText || "(empty message)"}</p>
    );

  /** Two independent toggles, one line, and only the ones that apply. */
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
        <div class="tight">
          <div class="row">
            <span class="lbl">To</span>
            <span class="val">
              {recipients.primary}
              {recipients.extra && <span class="muted"> · {recipients.extra}</span>}
            </span>
          </div>
          <h2 class="subject">{d.subject || "(no subject)"}</h2>
        </div>
        {bodyBlock(expanded || showHtml)}
        {bodyLinks(clipped && !showHtml)}
        {footer}
      </>
    );
  }

  // ---- fullscreen ---------------------------------------------------------

  const cc = d.recipients?.cc ?? [];
  const bcc = d.recipients?.bcc ?? [];
  const rows: Array<[string, string]> = [
    ["To", (d.recipients?.to ?? []).join(", ") || "(none)"],
    ...(cc.length ? ([["Cc", cc.join(", ")]] as Array<[string, string]>) : []),
    ...(bcc.length ? ([["Bcc", bcc.join(", ")]] as Array<[string, string]>) : []),
    ...(from ? ([["From", from]] as Array<[string, string]>) : []),
  ];

  return (
    <>
      {header}
      <h2 class="subject">{d.subject || "(no subject)"}</h2>
      <Fields rows={rows} />
      {bodyBlock(true)}
      {bodyLinks(false)}
      {footer}
    </>
  );
}

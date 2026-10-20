import type { Receipt as ReceiptData } from "../contract";
import { CARD_LANGUAGE, receiptDetail } from "../format";
import { TextLink } from "./ui";

type Tone = "success" | "danger" | "warning" | "neutral";

const TONES: Record<string, Tone> = {
  sent: "success",
  executed: "success",
  scheduled: "success",
  rejected: "neutral",
  discarded: "neutral",
  cancelled: "neutral",
  decided_elsewhere: "neutral",
  expired: "warning",
  failed: "danger",
};

const FALLBACK_HEADLINES: Record<string, string> = {
  sent: "Sent",
  executed: "Done",
  scheduled: "Scheduled",
  rejected: "Rejected. Nothing was sent.",
  discarded: "Draft discarded. Nothing was sent.",
  cancelled: "Cancelled. Nothing was changed.",
  decided_elsewhere: "Already decided elsewhere",
  expired: "Expired. Nothing was sent.",
  failed: "Could not complete",
};

/**
 * The words for a receipt's dashboard link, or null for no link.
 *
 * Only a page that is ABOUT the receipt earns a link. The dashboard's home page
 * (`/dashboard`, which every draft receipt carries) has no view of a draft or a
 * sent message, so "Open in dashboard" there promised the message and opened
 * an overview (2026-10-15). The approvals queue is about an approval receipt;
 * the Settings and Inboxes pages hold the "Show the draft editor card" switch
 * a turned-off card points at (App.tsx#turnOnUrl).
 */
export function dashboardLinkLabel(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  let path: string;
  try {
    path = new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
  if (path === "" || path === "/dashboard") return null;
  if (path === "/dashboard/settings" || path === "/dashboard/inboxes") return "Turn cards back on";
  return "Open in dashboard";
}

/**
 * A receipt is a fact, so it is one line.
 *
 * It used to be an uppercase eyebrow, a 20px headline, a detail paragraph, a
 * count line, a notice and a bordered button: six stacked blocks to say "Sent".
 * The outcome word is dropped from the render entirely because the headline
 * already contains it ("Sent", "Rejected. Nothing was sent.") and the dot
 * carries the tone.
 */
export function Receipt(props: {
  receipt: ReceiptData;
  busy: string | null;
  onOpenDashboard: () => void;
}) {
  const r = props.receipt;
  const tone = TONES[r.outcome] ?? "neutral";
  const headline =
    r.headline?.trim() || FALLBACK_HEADLINES[r.outcome] || "Done";
  const detail = [
    receiptDetail(r.detail),
    typeof r.affected_count === "number" && r.affected_count > 1
      ? `${r.affected_count.toLocaleString(CARD_LANGUAGE)} messages affected.`
      : null,
    r.outcome === "failed" && r.error_code ? `Error: ${r.error_code}` : null,
  ]
    .filter((s): s is string => !!s)
    .join(" ");

  const link = dashboardLinkLabel(r.dashboard_url);

  return (
    <>
      <div class="hdr">
        <div class="hdr-l">
          <span class="dot" data-tone={tone} aria-hidden="true" />
          <b>{headline}</b>
        </div>
        {link && (
          <div class="hdr-r">
            <TextLink onClick={props.onOpenDashboard}>{link}</TextLink>
          </div>
        )}
      </div>
      {detail && <p class="line">{detail}</p>}
    </>
  );
}

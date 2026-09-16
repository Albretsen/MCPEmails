import type { Receipt as ReceiptData } from "../contract";
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
    r.detail?.trim() || null,
    typeof r.affected_count === "number" && r.affected_count > 1
      ? `${r.affected_count.toLocaleString()} messages affected.`
      : null,
    r.outcome === "failed" && r.error_code ? `Error: ${r.error_code}` : null,
  ]
    .filter((s): s is string => !!s)
    .join(" ");

  return (
    <>
      <div class="hdr">
        <div class="hdr-l">
          <span class="dot" data-tone={tone} aria-hidden="true" />
          <b>{headline}</b>
        </div>
        {r.dashboard_url && (
          <div class="hdr-r">
            <TextLink onClick={props.onOpenDashboard}>
              Open in dashboard
            </TextLink>
          </div>
        )}
      </div>
      {detail && <p class="line">{detail}</p>}
    </>
  );
}

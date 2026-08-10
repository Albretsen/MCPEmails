import type { Receipt as ReceiptData } from "../contract";
import { Btn, Notice } from "./ui";

type Tone = "success" | "danger" | "warning" | "neutral";

const TONES: Record<string, Tone> = {
  sent: "success",
  executed: "success",
  scheduled: "success",
  rejected: "neutral",
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
  cancelled: "Cancelled. Nothing was changed.",
  decided_elsewhere: "Already decided elsewhere",
  expired: "Expired. Nothing was sent.",
  failed: "Could not complete",
};

export function Receipt(props: {
  receipt: ReceiptData;
  busy: string | null;
  onOpenDashboard: () => void;
}) {
  const r = props.receipt;
  const tone = TONES[r.outcome] ?? "neutral";
  const headline =
    r.headline?.trim() || FALLBACK_HEADLINES[r.outcome] || "Done";

  return (
    <>
      <p class="eyebrow">
        <span class="status-dot" data-tone={tone} aria-hidden="true" />
        {r.outcome.replace(/_/g, " ")}
      </p>
      <h2 class="headline">{headline}</h2>
      {r.detail && <p class="muted" style={{ margin: 0 }}>{r.detail}</p>}
      {typeof r.affected_count === "number" && r.affected_count > 1 && (
        <p class="tiny">{r.affected_count.toLocaleString()} messages affected.</p>
      )}
      {r.outcome === "failed" && (
        <Notice tone="danger">
          {r.error_code ? `Error: ${r.error_code}` : "The operation failed."}
        </Notice>
      )}
      {r.dashboard_url && (
        <div class="actions">
          <Btn
            busy={props.busy === "dashboard"}
            onClick={props.onOpenDashboard}
          >
            Open in dashboard
            <span aria-hidden="true">&#8599;</span>
          </Btn>
        </div>
      )}
    </>
  );
}

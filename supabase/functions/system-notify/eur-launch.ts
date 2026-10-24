// The `billing.eur_launch` notification: the EUR launch dispatcher
// (apps/web/src/lib/stripe/eur-launch-run.ts) telling the owner that the
// launch is waiting on a failed preflight check, stopped part way, went live,
// or had legacy swap failures.
//
// WHY THE WEB APP WRITES THE WORDS. The dispatcher is the only thing that
// knows which check failed and what fixes it, and that list will change as
// Stripe does. So the payload carries a fixed `kind`, a subject and plain
// lines, and this template only checks their shape and caps their size. The
// dispatcher never puts a customer, subscription or email in them (counts,
// check codes and price ids only), which keeps the system_events contract.
//
// Pure, no Deno APIs, so apps/web tests it directly (eur-launch-alert.test.ts).

export const EUR_LAUNCH_KINDS = ["preflight_failed", "launch_failed", "live", "swap_failed"] as const;
type Kind = typeof EUR_LAUNCH_KINDS[number];

const MAX_LINES = 60;
const MAX_LINE = 600;

const FALLBACK_SUBJECT: Record<Kind, string> = {
  preflight_failed: "EUR launch is waiting on a failed check",
  launch_failed: "EUR launch stopped part way",
  live: "EUR launch live",
  swap_failed: "EUR launch: legacy EU swap failures",
};

/** The email for one `billing.eur_launch` event, or null for a payload of the wrong shape. */
export function renderEurLaunchEmail(payload: Record<string, unknown>): { subject: string; body: string } | null {
  const kind = payload.kind;
  if (typeof kind !== "string" || !(EUR_LAUNCH_KINDS as readonly string[]).includes(kind)) return null;
  const rawSubject = typeof payload.subject === "string" ? payload.subject.trim() : "";
  const subject = (rawSubject || FALLBACK_SUBJECT[kind as Kind]).replace(/[\r\n]+/g, " ").slice(0, 160);
  const lines = Array.isArray(payload.lines)
    ? payload.lines.filter((line): line is string => typeof line === "string").slice(0, MAX_LINES)
      .map((line) => line.slice(0, MAX_LINE))
    : [];
  const body = [
    ...(lines.length ? lines : [subject]),
    "",
    "Sent by the EUR launch dispatcher (/api/internal/eur-launch/dispatch).",
  ].join("\n");
  return { subject, body };
}

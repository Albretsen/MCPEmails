// The `email.send_failed` notification: Resend refused (or threw on) a send
// from the web app. Emitted by apps/web/src/lib/email/resend-failure-alert.ts,
// at most once an hour per instance for each sender domain + error, so a
// silent outage (an unverified domain, a revoked key, a used-up quota) reaches
// the owner within minutes instead of days.
//
// The payload never carries a recipient: the web app masks every address in
// the message down to its domain before emitting.
//
// Pure, no Deno APIs, so apps/web tests it directly.

const text = (value: unknown, fallback = "unknown") =>
  typeof value === "string" && value.trim() ? value.replace(/[\r\n]+/g, " ").slice(0, 500) : fallback;
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown");

export function renderEmailSendFailedEmail(payload: Record<string, unknown>): { subject: string; body: string } {
  const domain = text(payload.from_domain);
  const name = text(payload.error_name);
  const env = text(payload.app_env, "production");
  const envTag = env === "production" ? "" : ` [${env}]`;
  return {
    subject: `Resend refused mail from ${domain}: ${name}${envTag}`.slice(0, 160),
    body: [
      `Resend refused a ${payload.kind === "batch" ? `batch of ${num(payload.count)} emails` : "send"} from ${domain}.`,
      "",
      `error: ${name} (status ${num(payload.status_code)})`,
      `message: ${text(payload.message, "(none)")}`,
      `environment: ${env}`,
      "",
      "Customers are not getting this mail until it is fixed. The callers log and carry on, so nothing else will say so.",
      "Check the domain in https://resend.com/domains and the *_FROM env vars in Vercel.",
      "Every failure is also a row in app_errors (context->>'source' = 'resend'). This alert repeats at most once an hour per instance.",
    ].join("\n"),
  };
}

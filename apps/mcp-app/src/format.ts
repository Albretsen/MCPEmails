// ---------------------------------------------------------------------------
// Formatting helpers.
//
// Phase-0 Q6: the reference host provides neither `locale` nor `timeZone`, so
// nothing here may assume them. Dates are formatted with the browser's own
// resolved locale/zone, with `hostContext.locale` used only when the host
// actually sent one.
// ---------------------------------------------------------------------------

let locale: string | undefined;

export function setLocale(l: string | undefined) {
  locale = typeof l === "string" && l.length > 1 ? l : undefined;
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(d);
  } catch {
    return d.toISOString().replace("T", " ").slice(0, 16);
  }
}

export function formatDate(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** "expires in 23h", "expires in 12 min", "expired". */
export function relativeExpiry(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "";
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return "expired";
  const min = Math.round(ms / 60000);
  if (min < 60) return `expires in ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `expires in ${hours}h`;
  return `expires ${formatDate(iso)}`;
}

export function formatBytes(n: unknown): string {
  const bytes = typeof n === "number" && isFinite(n) && n >= 0 ? n : 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Recipient summary that stays on one line at 320px. */
export function summarizeRecipients(
  to: string[],
  cc: string[],
  bccCount: number,
): { primary: string; extra: string } {
  const first = to[0] ?? "(no recipient)";
  const rest = Math.max(0, to.length - 1);
  const bits: string[] = [];
  if (rest > 0) bits.push(`+${rest} more`);
  if (cc.length > 0) bits.push(`${cc.length} cc`);
  if (bccCount > 0) bits.push(`${bccCount} bcc`);
  return { primary: first, extra: bits.join(" · ") };
}

const OPERATION_LABELS: Record<string, string> = {
  email_send: "Send email",
  email_reply: "Send reply",
  email_forward: "Forward email",
  draft_send: "Send draft",
  schedule_create: "Schedule email",
};

export function operationLabel(op: string): string {
  return OPERATION_LABELS[op] ?? "Send email";
}

const ACTION_LABELS: Record<string, string> = {
  delete_batch: "Delete",
  search_and_delete: "Delete",
  move_batch: "Move",
  search_and_move: "Move",
};

export function bulkVerb(action: string): string {
  return ACTION_LABELS[action] ?? "Modify";
}

export function bulkVerbProgressive(action: string): string {
  const v = bulkVerb(action);
  return v === "Delete" ? "Deleting" : v === "Move" ? "Moving" : "Working";
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

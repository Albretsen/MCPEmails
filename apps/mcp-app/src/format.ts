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

/** "10:04". Used in the model-context line, where the date is redundant. */
export function formatClock(iso: string | null | undefined): string {
  const d = parse(iso);
  if (!d) return "";
  try {
    return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(d);
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

/** Whitespace-separated tokens. The body is counted, never quoted. */
export function wordCount(text: string | null | undefined): number {
  if (typeof text !== "string") return 0;
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Contract §8, the line the card sends after a successful save:
 *
 *   User edited draft Drafts:3 in the editor at 10:04. Subject: "…". To 1,
 *   cc 1, bcc 0. Body 412 words. Current draft_id is Drafts:3.
 *
 * Body-free on purpose. The model gets the shape of the draft — who it is to,
 * what it is about, how long it is, and above all which id is live now — and
 * not a word of what the user wrote. §8 prints the same id in both positions,
 * which is the post-save id, so that is what both use: on IMAP the id the card
 * was mounted with is dead by the time this is sent, and naming it here would
 * hand the model the one id it must not call back with.
 */
export function draftSavedContextLine(draft: {
  draft_id?: string;
  subject?: string;
  recipients?: { to?: string[]; cc?: string[]; bcc?: string[] };
  body?: { text?: string };
  last_saved_at?: string | null;
}): string {
  const id = draft.draft_id || "unknown";
  const at = formatClock(draft.last_saved_at) || formatClock(new Date().toISOString());
  const subject = (draft.subject ?? "").trim() || "(no subject)";
  const to = draft.recipients?.to?.length ?? 0;
  const cc = draft.recipients?.cc?.length ?? 0;
  const bcc = draft.recipients?.bcc?.length ?? 0;
  const words = wordCount(draft.body?.text);
  return (
    `User edited draft ${id} in the editor at ${at}. ` +
    `Subject: "${subject}". To ${to}, cc ${cc}, bcc ${bcc}. ` +
    `Body ${words} words. Current draft_id is ${id}.`
  );
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

// ---------------------------------------------------------------------------
// Signature split
// ---------------------------------------------------------------------------

/**
 * The RFC 3676 §4.3 signature separator, and the sloppy variant that mail
 * clients emit anyway. Ordered longest-first so the correct form wins when both
 * would match at the same place.
 */
const SIG_SEPARATORS = ["\n-- \n", "\n--\n"] as const;

export interface SplitBody {
  /** Everything before the separator. The whole text when there is none. */
  message: string;
  /** The exact separator found, or null. Kept so `joinBody` is byte-exact. */
  separator: string | null;
  /** Everything after the separator, or null when there is none. */
  signature: string | null;
}

/**
 * Split a draft body into message and signature.
 *
 * Why this exists: the stored body carries the signature inline (contract §8
 * requires the card to show and save the text as-is, or the signature doubles),
 * and for a short message the signature is most of the box. Splitting lets the
 * card dim it without changing a byte of what gets saved.
 *
 * The LAST separator wins. A line of exactly `--` is legal inside prose, and
 * when it appears the signature is still the final block, so scanning from the
 * end is both the standard heuristic and the safe one: the worst case is that a
 * trailing prose block is styled as a signature, which is cosmetic. It is never
 * a correctness risk, because `joinBody(splitBody(t))` is `t` for every input.
 */
export function splitBody(text: string): SplitBody {
  for (const separator of SIG_SEPARATORS) {
    const at = text.lastIndexOf(separator);
    if (at !== -1) {
      return {
        message: text.slice(0, at),
        separator,
        signature: text.slice(at + separator.length),
      };
    }
  }
  return { message: text, separator: null, signature: null };
}

/** Inverse of `splitBody`. Byte-exact by construction. */
export function joinBody(parts: SplitBody): string {
  if (parts.separator === null || parts.signature === null) return parts.message;
  return parts.message + parts.separator + parts.signature;
}

// ---------------------------------------------------------------------------
// What a held `draft{action:"send"}` was approved AS, and whether the draft
// still says that when the approved send runs.
//
// THE HOLE (security review 2026-10-16, F-04-03 / F-04-04). A draft_send
// approval used to store a draft id and nothing else. The reviewer saw the
// recipients and subject read at queue time and never the body ("stored with
// your provider"), and the dispatcher sent the provider's draft as it was at
// dispatch time. The only thing tying the two together was the lineage
// revision, and that fails open for a draft no line names (a Gmail or Outlook
// draft written in the mail client): the agent could queue it, then rewrite
// the draft (adding a Bcc, putting harvested data in the body) and the approved
// send delivered the rewritten copy.
//
// THE FIX, in two halves that both live here so they are tested together:
//
//   1. At queue time the server reads the draft itself and stores a SNAPSHOT
//      of it on the approval (inside the encrypted payload): recipients, Bcc
//      included, subject, both bodies, attachment names and sizes. That is
//      what the review page and the card render, so the reviewer reads the
//      message, not a pointer to it.
//   2. With it, a DIGEST of the full draft (not the clipped snapshot). The
//      approved send re-reads the draft immediately before sending and sends
//      ONLY if the digest still matches. Anything else is refused with a
//      sentence the approver can act on, and nothing is sent.
//
// The digest is over content, not over the provider's own modified-time: a
// mail client that re-saves an untouched draft (Outlook does) must not make
// every approved send fail. It covers who the message is from and where
// replies go (From, Reply-To) and how it threads (In-Reply-To, References), so
// a Reply-To swapped to the agent's own address after approval is caught too.
// Nothing a provider regenerates on its own (Date, Message-ID, MIME
// boundaries, header order or folding) is in it, and attachments are sorted,
// so an untouched draft digests the same on every re-read. For Gmail and IMAP,
// whose readers parse the raw message, the files' bytes are digested too;
// Outlook's reader reports names, sizes and types only.
// ---------------------------------------------------------------------------

/** What a reader of one stored draft returns (index.ts#DraftContent, the fields used here). */
export interface DraftReadForSnapshot {
  subject: string;
  subjectAbsent?: boolean;
  to: string[];
  cc: string[];
  bcc: string[];
  /** From and Reply-To as parsed addresses. Absent when the reader has none. */
  headerFrom?: string[];
  headerReplyTo?: string[];
  inReplyTo?: string;
  references?: string;
  bodyText?: string | null;
  bodyHtml?: string | null;
  attachments?: { filename: string; size_bytes: number | null; mime_type: string | null }[];
  /** Files with their bytes (base64), when the reader parsed the raw message. */
  carried?: { encode(): { filename: string; mime_type: string; data: string }[] };
}

/** Stored on the approval payload as `draft_snapshot`. Rendered, never sent. */
export interface ApprovedDraftSnapshot {
  v: 1;
  to: string[];
  cc: string[];
  bcc: string[];
  /** Where replies go, when the draft names somewhere other than the sender. */
  reply_to: string[];
  subject: string;
  body_text: string | null;
  body_html: string | null;
  /** A body was clipped for display. The digest still covers all of it. */
  body_truncated: boolean;
  attachments: { filename: string; size_bytes: number | null; mime_type: string | null }[];
}

/** The payload keys a held draft send carries besides its tool arguments. */
export const DRAFT_SNAPSHOT_KEY = "draft_snapshot";
export const DRAFT_DIGEST_KEY = "draft_digest";

/** Same clip as the review surfaces (contract §2): 64 KB of UTF-8 per body. */
const SNAPSHOT_BODY_CLIP_BYTES = 64 * 1024;

function clip(value: string | null | undefined): { value: string | null; truncated: boolean } {
  if (typeof value !== "string" || value.length === 0) return { value: null, truncated: false };
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= SNAPSHOT_BODY_CLIP_BYTES) return { value, truncated: false };
  const decoded = new TextDecoder("utf-8").decode(bytes.slice(0, SNAPSHOT_BODY_CLIP_BYTES));
  return { value: decoded.replace(/�$/, ""), truncated: true };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function draftSnapshotOf(draft: DraftReadForSnapshot): ApprovedDraftSnapshot {
  const text = clip(draft.bodyText);
  const html = clip(draft.bodyHtml);
  return {
    v: 1,
    to: strings(draft.to),
    cc: strings(draft.cc),
    bcc: strings(draft.bcc),
    reply_to: strings(draft.headerReplyTo),
    subject: draft.subjectAbsent ? "" : (draft.subject ?? ""),
    body_text: text.value,
    body_html: html.value,
    body_truncated: text.truncated || html.truncated,
    attachments: (draft.attachments ?? []).slice(0, 100).map((a) => ({
      filename: typeof a.filename === "string" ? a.filename : "attachment",
      size_bytes: typeof a.size_bytes === "number" ? a.size_bytes : null,
      mime_type: typeof a.mime_type === "string" ? a.mime_type : null,
    })),
  };
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * SHA-256 over everything that decides what the send delivers and to whom.
 * A fixed-order array, so the encoding cannot depend on key order.
 */
export async function draftDigest(draft: DraftReadForSnapshot): Promise<string> {
  let fileBytes: string[] = [];
  if (draft.carried) {
    fileBytes = (await Promise.all(
      draft.carried.encode().map(async (f) => `${f.filename}\u0000${f.mime_type}\u0000${await sha256Hex(f.data)}`),
    )).sort();
  }
  const canonical = JSON.stringify([
    "draft-digest-v2",
    strings(draft.to),
    strings(draft.cc),
    strings(draft.bcc),
    strings(draft.headerFrom),
    strings(draft.headerReplyTo),
    idList(draft.inReplyTo),
    idList(draft.references),
    draft.subjectAbsent ? null : (draft.subject ?? ""),
    draft.bodyText ?? "",
    draft.bodyHtml ?? "",
    sortedAttachments(draft.attachments),
    fileBytes,
  ]);
  return await sha256Hex(canonical);
}

/** A Message-ID list as its ids, so header folding cannot change the digest. */
function idList(value: string | undefined): string {
  return typeof value === "string" ? value.split(/\s+/).filter(Boolean).join(" ") : "";
}

/**
 * Attachments in a fixed order (name, size, type): a provider is free to list
 * the same files in another order on the next read.
 */
function sortedAttachments(list: DraftReadForSnapshot["attachments"]): [string | null, number | null, string | null][] {
  const rows = (list ?? []).map((a): [string | null, number | null, string | null] => [
    a.filename ?? null,
    a.size_bytes ?? null,
    a.mime_type ?? null,
  ]);
  const key = (r: [string | null, number | null, string | null]) =>
    `${r[0] ?? ""}\u0000${String(r[1] ?? -1).padStart(16, "0")}\u0000${r[2] ?? ""}`;
  return rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export type ApprovedDraftCheck = "match" | "changed" | "unverified";

/**
 * Whether an approved draft send may go out.
 *
 * `unverified`: the approval carries no digest (queued before this check
 * existed, or written by something else). Refused: the reviewer approved a
 * draft whose content nobody recorded, which is the exact hole this closes.
 *
 * Legacy rows, checked in production on 2026-10-20 (read-only): the only
 * draft_send approvals created before #126 deployed (2026-10-16 19:00 UTC)
 * that were still `pending` had all lapsed past their 24h `expires_at` before
 * #126 shipped, so no decide path can approve them, and none was approved and
 * still undispatched; activity_log had no `approved_draft_unverified` row. No
 * approval can reach `unverified` any more except one written by something
 * other than queueSendApproval, so there is deliberately no re-approval path:
 * refusing stays the only safe answer, and it never sends unverified content.
 */
export function checkApprovedDraft(
  approvedDigest: unknown,
  currentDigest: string | null,
): ApprovedDraftCheck {
  if (typeof approvedDigest !== "string" || !/^[0-9a-f]{64}$/.test(approvedDigest)) return "unverified";
  if (currentDigest === null) return "changed";
  return approvedDigest === currentDigest ? "match" : "changed";
}

/**
 * Split what the dispatcher decrypted into the tool arguments to re-run and
 * the digest the run must match. The snapshot and digest never reach the tool
 * as arguments.
 */
export function splitApprovedDraftPayload(
  payload: Record<string, unknown>,
): { args: Record<string, unknown>; digest: string | null } {
  const { [DRAFT_SNAPSHOT_KEY]: _snapshot, [DRAFT_DIGEST_KEY]: digest, ...args } = payload;
  return { args, digest: typeof digest === "string" ? digest : null };
}

/** The snapshot on a decrypted approval payload, or null. */
export function approvedDraftSnapshotFrom(
  payload: Record<string, unknown> | null | undefined,
): ApprovedDraftSnapshot | null {
  const raw = payload?.[DRAFT_SNAPSHOT_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  return {
    v: 1,
    to: strings(s.to),
    cc: strings(s.cc),
    bcc: strings(s.bcc),
    reply_to: strings(s.reply_to),
    subject: typeof s.subject === "string" ? s.subject : "",
    body_text: typeof s.body_text === "string" ? s.body_text : null,
    body_html: typeof s.body_html === "string" ? s.body_html : null,
    body_truncated: s.body_truncated === true,
    attachments: Array.isArray(s.attachments)
      ? (s.attachments as unknown[]).map((entry) => {
        const a = (entry ?? {}) as Record<string, unknown>;
        return {
          filename: typeof a.filename === "string" ? a.filename : "attachment",
          size_bytes: typeof a.size_bytes === "number" ? a.size_bytes : null,
          mime_type: typeof a.mime_type === "string" ? a.mime_type : null,
        };
      })
      : [],
  };
}

/**
 * The `scheduled_sends.error_detail` for an approved draft send refused by
 * this check. In the approver's words; the dashboard shows it.
 */
export const APPROVED_DRAFT_CHANGED_DETAIL =
  "Not sent. The draft was changed after this send was approved, so it no longer says what was " +
  "approved. Review the draft and send it again.";
export const APPROVED_DRAFT_UNREADABLE_DETAIL =
  "Not sent yet. The draft could not be read to check it against the approved version, so " +
  "nothing was sent. It is retried automatically for a while; if it keeps failing, send the draft again.";
export const APPROVED_DRAFT_UNVERIFIED_DETAIL =
  "Not sent. This send was approved without a recorded copy of the draft, so it could not be " +
  "checked against what was approved. Review the draft and send it again.";

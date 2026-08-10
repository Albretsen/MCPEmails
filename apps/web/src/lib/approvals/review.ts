import { decryptToken } from '@/lib/crypto';
import { neutralizeList, neutralizeNullable, neutralizeText } from '@/lib/textSafety';
import { canDecide, isExpired } from './decide';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Server-side loader for the /approvals/[id] review page.
 *
 * BODY VISIBILITY — deliberate, documented decision.
 *
 * The dashboard list deliberately shows no body: it is a queue view rendered
 * for every workspace member, and a body there would leak message content into
 * a screen nobody asked to open. This page is the opposite: it is the one
 * place a human is asked to take responsibility for an irreversible send, and
 * approving without seeing what will be sent is a rubber stamp. Recipients and
 * a subject line cannot catch the attack this feature exists to stop — a
 * prompt-injected agent writing harvested data into the body of a message to a
 * plausible-looking recipient.
 *
 * So the body IS shown here, under these constraints:
 *
 *  1. Decrypted per request, in the server component, from the same
 *     AES-256-GCM ciphertext the edge function wrote. Nothing is written back
 *     in plaintext; the encryption-at-rest story is unchanged.
 *  2. Plain text only. An HTML body is offered as escaped SOURCE, never
 *     rendered — rendering it would fetch remote images and beacon the
 *     reviewer's IP and read-time back to whoever composed the message, and it
 *     would make an approval screen depend on a sanitizer being correct.
 *  3. Clipped at 64 KB per body (contract §2) with an explicit truncation
 *     notice, so a huge payload cannot be used to bury the recipients.
 *  4. Withheld from the `viewer` role. Every other role (owner/admin/member)
 *     can already mint an API key and read the mailbox directly, so hiding the
 *     body from them would be theatre; `viewer` cannot, so for them it would be
 *     a real privilege escalation.
 *  5. The page is `force-dynamic`, `noindex`, and served `no-store`.
 *
 * BIDI / CONTROL CHARACTERS — see `@/lib/textSafety`.
 *
 * Every short field this page renders as a fact (recipients, subject,
 * attachment filenames, the inbox display name, the decider's label) is run
 * through `neutralizeText` first. An attachment named `invoice<U+202E> fdp.exe`
 * renders as `invoiceexe.pdf`, so a reviewer approving what they read as a PDF
 * would send an executable, and the same trick works on a subject line. This is
 * the surface the whole approval gate exists to protect, so it cannot be left
 * to the review card alone: this page is the only place an approval can
 * actually be granted.
 *
 * The BODY is deliberately exempt. Bidi controls are legitimate in Hebrew,
 * Arabic, Persian and Urdu prose, and stripping them would corrupt mail we are
 * only meant to be showing. The body is also presented as a block of untrusted
 * message text rather than as a field, and HTML is shown as escaped source and
 * never rendered.
 */

/** Contract §2: the server clips each body at 64 KB and flags the clip. */
const BODY_CLIP_BYTES = 64 * 1024;

export type ReviewLoadFailure = 'not_found';

export interface ReviewIdentity {
  inbox_id: string | null;
  email_address: string | null;
  display_name: string | null;
  provider: string | null;
  service: string | null;
}

export interface ReviewProvider {
  /** "Gmail API" | "Microsoft Graph" | "IMAP + SMTP" */
  labelKey: 'gmail' | 'outlook' | 'smtp';
  /** Concrete call or submission endpoint. */
  route: string;
  /** Message keys for send-relevant caveats, resolved in the UI. */
  caveatKeys: string[];
}

export interface ReviewBody {
  text: string | null;
  html: string | null;
  truncated: boolean;
  /** Why there is no body to show, when there isn't one. */
  unavailable: null | 'withheld_role' | 'stored_with_provider' | 'decrypt_failed' | 'absent';
}

export interface ReviewAttachment {
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
}

export interface ApprovalReviewModel {
  id: string;
  operation: string;
  status: string;
  /** Effective state: a pending row past its expiry reads as `expired`. */
  state: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';
  created_at: string | null;
  decided_at: string | null;
  decided_via: string | null;
  decided_by_label: string | null;
  expires_at: string | null;
  send_at: string | null;
  identity: ReviewIdentity;
  recipients: { to: string[]; cc: string[]; bcc_count: number };
  subject: string;
  attachment_count: number;
  attachments: ReviewAttachment[];
  body: ReviewBody;
  provider: ReviewProvider;
  role: string;
  canDecide: boolean;
  /** Recipients/subject are resolved at send time, not stored on the approval. */
  recipientsResolvedAtSend: boolean;
}

/**
 * Maps an inbox to the concrete outbound route that will carry the send.
 *
 * MUST stay word-for-word in step with `sendProviderBlock` in
 * `supabase/functions/mcp-server/mcp-app-approvals.ts`. That function is the
 * canonical one: it ships inside the AI conversation, and a user who reads one
 * description on the card and a different one here learns less than if both
 * had been vague. Labels, routes and caveat text are all mirrored; the caveats
 * live in the message catalogue so they can be translated, but the English
 * source strings are copied verbatim.
 *
 * (Contract §5 used to say send caveats came from `COMPATIBILITY_PROFILES.notes`.
 * That was wrong — the map has no send-relevant entries — and is corrected in
 * the contract. Those notes are for bulk operations only.)
 */
export function providerRouteFor(inbox: any): ReviewProvider {
  const provider = inbox?.provider ?? 'imap';
  if (provider === 'gmail') {
    return {
      labelKey: 'gmail',
      route: 'users.messages.send',
      caveatKeys: ['gmailThread', 'gmailSentLabel'],
    };
  }
  if (provider === 'outlook') {
    return {
      labelKey: 'outlook',
      route: 'me/sendMail',
      caveatKeys: ['outlookSentItems'],
    };
  }
  const host = inbox?.smtp_host || 'the configured SMTP host';
  const port = inbox?.smtp_port ?? 465;
  return {
    labelKey: 'smtp',
    route: `SMTP submission · ${host}:${port}`,
    caveatKeys: ['smtpNoSentCopy'],
  };
}

function clip(value: unknown): { value: string | null; truncated: boolean } {
  if (typeof value !== 'string' || value.length === 0) return { value: null, truncated: false };
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= BODY_CLIP_BYTES) return { value, truncated: false };
  const buf = Buffer.from(value, 'utf8').subarray(0, BODY_CLIP_BYTES);
  // Drop a trailing partial UTF-8 sequence rather than emitting U+FFFD.
  return { value: buf.toString('utf8').replace(/�$/, ''), truncated: true };
}

/**
 * Decrypts the stored snapshot. Returns null if the row is not decryptable —
 * never throws into the page render.
 */
function readPayload(approval: any): Record<string, unknown> | null {
  const payload = approval?.payload;
  if (!payload) return null;
  if (approval.payload_encrypted === false) {
    return typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  }
  const ciphertext = (payload as any)?.data;
  if (typeof ciphertext !== 'string') return null;
  try {
    const parsed = JSON.parse(decryptToken(ciphertext));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.error('[approvals] Failed to decrypt approval payload:', (error as Error)?.message);
    return null;
  }
}

function attachmentsFrom(payload: Record<string, unknown> | null): ReviewAttachment[] {
  const raw = payload?.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 25).map((entry: any) => {
    // The outbound tool schemas (email_send / email_reply / email_forward) all
    // declare the attachment payload as `data`, base64-encoded. Do not read
    // `content` — that key does not exist on this path and silently yields a
    // null size on every attachment.
    const data = typeof entry?.data === 'string' ? entry.data : null;
    return {
      filename: typeof entry?.filename === 'string' ? neutralizeText(entry.filename) : 'attachment',
      mime_type: typeof entry?.mime_type === 'string' ? neutralizeText(entry.mime_type) : null,
      // base64 → bytes, minus padding. Approximate is fine for a review line.
      size_bytes: data ? Math.max(0, Math.floor((data.length * 3) / 4)) : null,
    };
  });
}

function effectiveState(approval: any): ApprovalReviewModel['state'] {
  const status = String(approval?.status ?? 'pending');
  if (status === 'pending' && isExpired(approval)) return 'expired';
  if (status === 'approved' || status === 'rejected' || status === 'cancelled' || status === 'expired') {
    return status;
  }
  return 'pending';
}

/**
 * Loads an approval for review.
 *
 * AUTHORISATION: the caller passes an authenticated user id. Membership is
 * resolved from the approval's OWN workspace (not the active-workspace
 * cookie) — a review link arrives from a Claude conversation and has no
 * relationship to whichever workspace the browser last looked at.
 *
 * A non-existent id and an id in a workspace the user does not belong to
 * return the SAME value, so the page cannot be used as an existence oracle.
 */
export async function loadApprovalForReview(
  db: any,
  approvalId: string,
  userId: string,
): Promise<ApprovalReviewModel | ReviewLoadFailure> {
  const { data: approval } = await db
    .from('send_approvals')
    .select('*, inboxes(id, email_address, display_name, provider, service, smtp_host, smtp_port)')
    .eq('id', approvalId)
    .maybeSingle();

  if (!approval) return 'not_found';

  const { data: membership } = await db
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', approval.workspace_id)
    .eq('user_id', userId)
    .maybeSingle();

  // Same answer as "no such approval" — no existence oracle.
  if (!membership) return 'not_found';

  const role = String(membership.role ?? 'viewer');
  const inbox = approval.inboxes ?? {};
  const summary = (approval.summary ?? {}) as Record<string, unknown>;
  const state = effectiveState(approval);

  let decidedByLabel: string | null = null;
  if (approval.decided_by) {
    const { data: decider } = await db
      .from('users')
      .select('display_name, email')
      .eq('id', approval.decided_by)
      .maybeSingle();
    decidedByLabel = neutralizeNullable(decider?.display_name || decider?.email || null);
  }

  // `draft_send` stores only a draft id; the message itself lives with the
  // provider and is never copied into the approval.
  const contentLivesWithProvider = approval.operation === 'draft_send';

  let body: ReviewBody = { text: null, html: null, truncated: false, unavailable: 'absent' };
  if (role === 'viewer') {
    body = { text: null, html: null, truncated: false, unavailable: 'withheld_role' };
  } else if (contentLivesWithProvider) {
    body = { text: null, html: null, truncated: false, unavailable: 'stored_with_provider' };
  }

  let payload: Record<string, unknown> | null = null;
  if (role !== 'viewer') {
    payload = readPayload(approval);
    if (!payload && approval.payload) {
      body = { text: null, html: null, truncated: false, unavailable: 'decrypt_failed' };
    } else if (payload && !contentLivesWithProvider) {
      const text = clip(payload.body);
      const html = clip(payload.html_body);
      body = {
        text: text.value,
        html: html.value,
        truncated: text.truncated || html.truncated,
        unavailable: text.value || html.value ? null : 'absent',
      };
    }
  }

  const summaryTo = neutralizeList(summary.to).filter(Boolean);
  const summaryCc = neutralizeList(summary.cc).filter(Boolean);
  const payloadTo = neutralizeList(payload?.to).filter(Boolean);
  const payloadCc = neutralizeList(payload?.cc).filter(Boolean);
  const to = summaryTo.length ? summaryTo : payloadTo;
  const cc = summaryCc.length ? summaryCc : payloadCc;
  const subject = neutralizeText(
    (typeof summary.subject === 'string' && summary.subject) ||
      (typeof payload?.subject === 'string' && (payload!.subject as string)) ||
      '',
  );

  const attachments = attachmentsFrom(payload);
  const attachmentCount =
    typeof summary.attachment_count === 'number'
      ? (summary.attachment_count as number)
      : attachments.length;

  return {
    id: approval.id,
    operation: String(approval.operation ?? 'email_send'),
    status: String(approval.status ?? 'pending'),
    state,
    created_at: approval.created_at ?? null,
    decided_at: approval.decided_at ?? null,
    decided_via: approval.decided_via ?? null,
    decided_by_label: decidedByLabel,
    expires_at: approval.expires_at ?? null,
    send_at: approval.send_at ?? null,
    identity: {
      inbox_id: inbox.id ?? approval.inbox_id ?? null,
      email_address: neutralizeNullable(inbox.email_address ?? null),
      display_name: neutralizeNullable(inbox.display_name ?? null),
      provider: inbox.provider ?? null,
      service: inbox.service ?? null,
    },
    recipients: {
      to,
      cc,
      bcc_count: typeof summary.bcc_count === 'number' ? (summary.bcc_count as number) : 0,
    },
    subject,
    attachment_count: attachmentCount,
    attachments,
    body,
    provider: providerRouteFor(inbox),
    role,
    canDecide: canDecide(role),
    // Used to mean "an empty To is expected here". It no longer is: since
    // `buildApprovalSummary` (supabase/functions/mcp-server/index.ts) resolves
    // the real recipients and subject at queue time, a reply and a draft-send
    // both arrive with a populated summary. An empty To on one of these
    // operations now means the queue-time resolution FAILED — the provider read
    // did not come back — and the recipients will only be known at send time.
    //
    // That is a materially different message to the reviewer: not "this is
    // normal", but "this send is going somewhere this page cannot show you".
    // The flag is kept (the UI still needs to distinguish it from a genuinely
    // absent recipient on an email_send) and the copy behind it was rewritten
    // to say so.
    recipientsResolvedAtSend:
      to.length === 0 &&
      (approval.operation === 'email_reply' || approval.operation === 'draft_send'),
  };
}

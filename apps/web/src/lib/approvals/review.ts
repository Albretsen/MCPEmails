import { neutralizeList, neutralizeNullable, neutralizeText } from '@/lib/textSafety';
import { canDecide, isExpired } from './decide';
import { bccFromPayload, draftSnapshotFrom, isUnsendableLegacyDraft, readPayload, readSummary } from './payload';
import { deliveryFromScheduledSend, loadScheduledSendsByApproval, type ApprovalDelivery } from './delivery';
import { withApprovalOrigin, type ApprovalKind } from './origin';

export { reviewerBccFor } from './payload';

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
 * BCC — shown in full here (security review 2026-10-16, F-04-05), under the
 * same role rule as the body. A count alone let a hidden exfiltration
 * recipient be approved blind. The MCP channel (the card, and the model) still
 * gets a count only; this page and the dashboard dialog are the signed-in
 * surfaces where a send is approved, so this is where the addresses belong.
 *
 * DRAFT SENDS — a held `draft_send` now carries the server's own read of the
 * draft (`draft_snapshot`, supabase/functions/mcp-server/draft-send-snapshot.ts),
 * and the approved send goes out only while the draft still matches it. So
 * the body IS shown for a draft send too. Only an approval queued before the
 * snapshot existed still reads "stored with your provider" (and its approved
 * send is refused).
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
  /**
   * `bcc` lists the addresses for owner/admin/member and is empty for
   * `viewer`, who sees the count only.
   */
  recipients: { to: string[]; cc: string[]; bcc: string[]; bcc_count: number };
  /**
   * The version of the request this model was built from. The page submits it
   * with the decision, and an approve of any other version is refused.
   */
  revision: number | null;
  /**
   * Where replies to this message go, when it names somewhere other than the
   * sender. Empty for `viewer` (who sees no message content).
   */
  reply_to: string[];
  /**
   * False for a draft send queued before the server recorded a copy of the
   * draft: it can never be sent (see payload.ts#isUnsendableLegacyDraft), so
   * Approve is disabled while Reject stays available.
   */
  approvable: boolean;
  subject: string;
  attachment_count: number;
  /** A forward that relays the original's own attachments (none are arguments). */
  forward_carries_original: boolean;
  attachments: ReviewAttachment[];
  body: ReviewBody;
  provider: ReviewProvider;
  role: string;
  canDecide: boolean;
  /** Recipients/subject are resolved at send time, not stored on the approval. */
  recipientsResolvedAtSend: boolean;
  /** A rule forward or an AI send, and which rule. */
  kind: ApprovalKind;
  rule_name: string | null;
  /** What happened after approval; null for any other state. */
  delivery: ApprovalDelivery | null;
  /** Why a no-approval rule did not send this one, while it waits. */
  wait_reason: string | null;
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
      route: 'me/messages/{id}/send',
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

function draftAttachmentsFrom(snapshot: Record<string, any> | null): ReviewAttachment[] {
  const raw = snapshot?.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 25).map((entry: any) => ({
    filename: typeof entry?.filename === 'string' ? neutralizeText(entry.filename) : 'attachment',
    mime_type: typeof entry?.mime_type === 'string' ? neutralizeText(entry.mime_type) : null,
    size_bytes: typeof entry?.size_bytes === 'number' ? entry.size_bytes : null,
  }));
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
  const summary = readSummary(approval.summary);
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

  // `draft_send` is a draft that lives with the provider. Since 2026-10-16 the
  // server records a snapshot of it when the send is held; an older approval
  // has none, and only then is there nothing to show.
  const isDraftSend = approval.operation === 'draft_send';

  let body: ReviewBody = { text: null, html: null, truncated: false, unavailable: 'absent' };
  if (role === 'viewer') {
    body = { text: null, html: null, truncated: false, unavailable: 'withheld_role' };
  }

  let payload: Record<string, unknown> | null = null;
  let draftSnapshot: Record<string, any> | null = null;
  if (role !== 'viewer') {
    payload = readPayload(approval);
    draftSnapshot = isDraftSend ? draftSnapshotFrom(payload) : null;
    if (!payload && approval.payload) {
      body = { text: null, html: null, truncated: false, unavailable: 'decrypt_failed' };
    } else if (isDraftSend && !draftSnapshot) {
      body = { text: null, html: null, truncated: false, unavailable: 'stored_with_provider' };
    } else if (payload) {
      const text = clip(draftSnapshot ? draftSnapshot.body_text : payload.body);
      const html = clip(draftSnapshot ? draftSnapshot.body_html : payload.html_body);
      body = {
        text: text.value,
        html: html.value,
        truncated: text.truncated || html.truncated || draftSnapshot?.body_truncated === true,
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

  const attachments = draftSnapshot ? draftAttachmentsFrom(draftSnapshot) : attachmentsFrom(payload);
  // A draft's files are not arguments, so the summary counts none of them.
  const attachmentCount = draftSnapshot
    ? attachments.length
    : typeof summary.attachment_count === 'number'
      ? (summary.attachment_count as number)
      : attachments.length;
  const bcc = role === 'viewer' ? [] : bccFromPayload(approval.operation, payload);
  const replyTo = role === 'viewer'
    ? []
    : neutralizeList(
        draftSnapshot
          ? draftSnapshot.reply_to
          : typeof payload?.reply_to === 'string'
            ? [payload.reply_to]
            : payload?.reply_to,
      ).filter(Boolean);
  // Decided from the payload itself, not from the role-dependent body above,
  // so a viewer's read-only page and an admin's page agree on it.
  const approvable = !isUnsendableLegacyDraft(approval, payload ?? readPayload(approval));
  const summaryBccCount = typeof summary.bcc_count === 'number' ? (summary.bcc_count as number) : 0;
  const origin = withApprovalOrigin({
    triage_rule_id: approval.triage_rule_id,
    triage_rule_name: approval.triage_rule_name,
  });
  const delivery = approval.status === 'approved'
    ? deliveryFromScheduledSend(
        (await loadScheduledSendsByApproval(db, approval.workspace_id, [approval.id])).get(approval.id),
        approval.send_at,
      )
    : null;

  return {
    id: approval.id,
    operation: String(approval.operation ?? 'email_send'),
    status: String(approval.status ?? 'pending'),
    state,
    created_at: approval.created_at ?? null,
    decided_at: approval.decided_at ?? null,
    // Older expired rows may carry the surface that noticed. Nobody decided them.
    decided_via: state === 'expired' ? null : approval.decided_via ?? null,
    decided_by_label: state === 'expired' ? null : decidedByLabel,
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
      bcc,
      // Never fewer than the addresses listed: a payload whose Bcc outgrew the
      // summary is shown as what will actually be sent.
      bcc_count: Math.max(summaryBccCount, bcc.length),
    },
    revision: typeof approval.revision === 'number' ? approval.revision : null,
    reply_to: replyTo,
    approvable,
    subject,
    attachment_count: attachmentCount,
    forward_carries_original: summary.forward_carries_original === true,
    attachments,
    body,
    provider: providerRouteFor(inbox),
    role,
    canDecide: canDecide(role),
    kind: origin.kind,
    rule_name: neutralizeNullable(origin.rule_name),
    delivery,
    wait_reason: typeof approval.no_approval_wait_reason === 'string' ? approval.no_approval_wait_reason : null,
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

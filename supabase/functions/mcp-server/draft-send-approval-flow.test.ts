// ---------------------------------------------------------------------------
// A held draft send, end to end over the fake Gmail network: what the approval
// records when the send is held, and what the scheduled-send dispatcher does
// with it once a human approved it.
//
// Security review 2026-10-16 (F-04-03, F-04-04). The bypass this pins shut:
//
//   1. the agent picks a draft no lineage line names (a Gmail draft written in
//      Gmail) and sends it with `base_revision: 1`, so the send is held;
//   2. the reviewer sees the draft's recipients and subject and approves;
//   3. between the two, the agent rewrites the draft in place (a Bcc to itself,
//      harvested data in the body). Gmail keeps the id, the update adopted the
//      draft into a lineage line at revision 1, and the approved re-run's
//      revision check compared 1 to 1 and sent the rewritten draft.
//
// Now the approval records the server's own read of the draft (body and Bcc
// included, for the reviewer) and a digest of it; the caller's base_revision is
// dropped; and the approved re-run sends only if the draft still matches.
//
// Real executor, real dispatcher, real crypto. Only the network is fake: Gmail
// is answered by the handler below and PostgREST by provider-call-harness (the
// global client) or the recording client handed to the dispatcher. Nothing is
// sent anywhere. Every address is a reserved example domain.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import * as harness from "./provider-call-harness.ts";
import {
  APPROVED_DRAFT_CHANGED_DETAIL,
  APPROVED_DRAFT_UNREADABLE_DETAIL,
  APPROVED_DRAFT_UNVERIFIED_DETAIL,
} from "./draft-send-snapshot.ts";

// The harness has already imported index.ts against its fake network; this is
// the same module instance.
const server = await import("./index.ts");

type Row = Record<string, unknown>;

const DRAFT_ID = "r-4242";
const APPROVAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SEND_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface FakeDraft {
  to: string;
  from?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  bcc?: string;
  subject: string;
  text: string;
}

function rawMime(d: FakeDraft): string {
  return [
    `From: ${d.from ?? "Harness Owner <owner@gmail-harness.example>"}`,
    `To: ${d.to}`,
    ...(d.replyTo ? [`Reply-To: ${d.replyTo}`] : []),
    ...(d.inReplyTo ? [`In-Reply-To: ${d.inReplyTo}`] : []),
    ...(d.references ? [`References: ${d.references}`] : []),
    ...(d.bcc ? [`Bcc: ${d.bcc}`] : []),
    `Subject: ${d.subject}`,
    "Date: Thu, 15 Oct 2026 10:00:00 +0000",
    "Message-ID: <draft-4242@gmail-harness.example>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    d.text,
    "",
  ].join("\r\n");
}

/** A Gmail that holds one draft (mutable by the test) and records sends. */
function gmail(draft: FakeDraft) {
  const sends: string[] = [];
  const handler: harness.ProviderHandler = (call) => {
    const url = new URL(call.url);
    if (url.pathname.endsWith(`/drafts/${DRAFT_ID}`) && call.method === "GET") {
      const headers = [
        { name: "To", value: draft.to },
        ...(draft.bcc ? [{ name: "Bcc", value: draft.bcc }] : []),
        { name: "Subject", value: draft.subject },
      ];
      return harness.json({
        id: DRAFT_ID,
        message: {
          id: "m-4242",
          threadId: "t-4242",
          internalDate: "1792058400000",
          payload: { headers },
          raw: harness.b64url(rawMime(draft)),
        },
      });
    }
    if (url.pathname.endsWith("/drafts/send") && call.method === "POST") {
      sends.push(String(call.body));
      return harness.json({ id: "sent-4242", threadId: "t-4242" });
    }
    return harness.json({ error: { code: 404 } }, 404);
  };
  return { handler, sends };
}

async function approvalInbox(): Promise<Row> {
  return await harness.inboxRow("gmail", { send_approval_required: true });
}

/** AES-GCM decrypt of the server's storage format, with the harness's key. */
async function decryptStored(ciphertext: string): Promise<Row> {
  const keyHex = "5a".repeat(32);
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) keyBytes[i] = parseInt(keyHex.substring(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const bin = atob(ciphertext.replace(/-/g, "+").replace(/_/g, "/"));
  const all = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12), tagLength: 128 }, key, all.slice(12));
  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * Hold a draft send. The harness's PostgREST answers an insert with no row, so
 * the queue reports itself unavailable; what matters here is the row the
 * server WROTE, which the harness recorded.
 */
async function holdDraftSend(draft: FakeDraft, args: Row = {}) {
  const { handler } = gmail(draft);
  const { world } = await harness.runTool(await approvalInbox(), handler, () =>
    server.dispatchExecutor(
      "draft_send",
      { inbox_id: harness.INBOX_ID, draft_id: DRAFT_ID, ...args },
      harness.API_KEY,
    ));
  const insert = world.db.find((c) => c.method === "POST" && c.target === "send_approvals");
  assert(insert, "an approval row was written");
  const row = insert.body as Row;
  const payload = await decryptStored(String((row.payload as Row).data));
  return { row, payload };
}

/** A Supabase client for the dispatcher: applies eq/is/lt/lte, mutates on update. */
function recordingClient(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const eq: Array<[string, unknown]> = [];
    const is: Array<[string, unknown]> = [];
    const lt: Array<[string, unknown]> = [];
    const lte: Array<[string, unknown]> = [];
    let patch: Row | null = null;
    const settle = () => {
      const rows = (tables[table] ?? []).filter((row) =>
        eq.every(([c, v]) => row[c] === v) && is.every(([c, v]) => row[c] === v) &&
        lt.every(([c, v]) => String(row[c]) < String(v)) && lte.every(([c, v]) => String(row[c]) <= String(v))
      );
      if (patch) for (const row of rows) Object.assign(row, patch);
      return { data: rows.map((r) => ({ ...r })), error: null };
    };
    const builder = {
      select: () => builder,
      update: (p: Row) => {
        patch = p;
        return builder;
      },
      eq: (c: string, v: unknown) => (eq.push([c, v]), builder),
      is: (c: string, v: unknown) => (is.push([c, v]), builder),
      lt: (c: string, v: unknown) => (lt.push([c, v]), builder),
      lte: (c: string, v: unknown) => (lte.push([c, v]), builder),
      order: () => builder,
      limit: () => builder,
      single: () => {
        const { data } = settle();
        return Promise.resolve(data.length ? { data: data[0], error: null } : { data: null, error: { message: "no rows" } });
      },
      maybeSingle: () => Promise.resolve({ data: settle().data[0] ?? null, error: null }),
      // deno-lint-ignore no-explicit-any
      then: (resolve: (v: any) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(settle()).then(resolve, reject),
    };
    return builder;
  };
  return { from };
}

/** Run the dispatcher over one approved approval whose payload is `payload` (encrypted as stored). */
async function dispatchApproved(draft: FakeDraft, storedPayload: Row) {
  const { handler, sends } = gmail(draft);
  return { sends, ...(await dispatchWith(await approvalInbox(), handler, storedPayload)) };
}

async function dispatchWith(inbox: Row, handler: harness.ProviderHandler, storedPayload: Row) {
  const tables: Record<string, Row[]> = {
    scheduled_sends: [{
      id: SEND_ID,
      // The dispatcher resolves the inbox, approval and key inside the row's
      // own workspace (u04), so the row carries it as the real table does.
      workspace_id: harness.WORKSPACE,
      inbox_id: harness.INBOX_ID,
      status: "pending",
      payload: { approval_id: APPROVAL_ID },
      payload_encrypted: false,
      // Due a moment ago, so a retryable refusal is inside the defer window.
      send_at: new Date(Date.now() - 1000).toISOString(),
      updated_at: new Date(Date.now() - 1000).toISOString(),
      sent_at: null,
      error_detail: null,
    }],
    send_approvals: [{
      id: APPROVAL_ID,
      workspace_id: harness.WORKSPACE,
      inbox_id: harness.INBOX_ID,
      api_key_id: harness.API_KEY.id,
      operation: "draft_send",
      payload: storedPayload,
      payload_encrypted: true,
      status: "approved",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      decided_at: new Date().toISOString(),
      // Single-use claim column (migration 20261016160400): unclaimed until
      // this row's dispatch binds it.
      dispatch_scheduled_send_id: null,
    }],
    api_keys: [{ ...harness.API_KEY, deleted_at: null }],
    inboxes: [{ ...inbox, deleted_at: null }],
  };
  await harness.runTool(inbox, handler, async () => {
    // deno-lint-ignore no-explicit-any
    const response = await server.handleScheduledDispatch(recordingClient(tables) as any);
    await response.body?.cancel();
  });
  // Every outcome these tests assert must come from the approved re-run, not
  // from an earlier tenancy or single-use gate refusing the row: the claim is
  // written just before the re-run, so it proves the row got that far.
  assertEquals(tables.send_approvals[0].dispatch_scheduled_send_id, SEND_ID, "the approval was claimed by this row");
  assert(
    !/not found|unavailable|already dispatched|Refused/.test(String(tables.scheduled_sends[0].error_detail ?? "")),
    `refused before the re-run: ${tables.scheduled_sends[0].error_detail}`,
  );
  return { scheduled: tables.scheduled_sends[0] };
}

const ORIGINAL: FakeDraft = {
  to: "Partner <partner@example.com>",
  subject: "Q3 notes",
  text: "See you Thursday.",
};

Deno.test("held draft send: the approval records the draft, Bcc and body included, and a server-chosen revision", async () => {
  const { row, payload } = await holdDraftSend({ ...ORIGINAL, bcc: "Auditor <audit@example.com>" }, { base_revision: 1 });
  assertEquals(row.operation, "draft_send");
  assertEquals(payload.draft_id, DRAFT_ID);
  // F-04-03: the caller's base_revision is never what is stored.
  assertEquals(payload.base_revision, 0);
  const snapshot = payload.draft_snapshot as Row;
  assertEquals(snapshot.to, ["Partner <partner@example.com>"]);
  assertEquals(snapshot.bcc, ["Auditor <audit@example.com>"]);
  assertEquals(snapshot.subject, "Q3 notes");
  assert(String(snapshot.body_text).includes("See you Thursday."), "the body the reviewer reads");
  assert(/^[0-9a-f]{64}$/.test(String(payload.draft_digest)), "a digest to check at dispatch");
  // The plaintext summary (dashboard queue, model channel) keeps Bcc as a count.
  const summary = row.summary as Row;
  assertEquals(summary.bcc_count, 1);
  assertEquals(summary.subject, "Q3 notes");
  assert(!JSON.stringify(summary).includes("audit@example.com"), "no Bcc address in the summary");
});

Deno.test("approved draft send: an untouched draft is sent", async () => {
  const { row } = await holdDraftSend(ORIGINAL);
  const { sends, scheduled } = await dispatchApproved(ORIGINAL, row.payload as Row);
  assertEquals(sends.length, 1, "drafts.send was called");
  assertEquals(JSON.parse(sends[0]).id, DRAFT_ID);
  assertEquals(scheduled.status, "sent");
});

Deno.test("bypass F-04-03: a draft rewritten after it was queued is NOT sent, and the approver is told why", async () => {
  const { row } = await holdDraftSend(ORIGINAL, { base_revision: 1 });
  for (
    const rewritten of [
      { ...ORIGINAL, bcc: "drop@evil.example" },
      { ...ORIGINAL, text: "See you Thursday. Harvested: 4111 1111 1111 1111" },
      { ...ORIGINAL, to: "Partner <partner@example.com>, drop@evil.example" },
      { ...ORIGINAL, subject: "Q3 notes (final)" },
    ]
  ) {
    const { sends, scheduled } = await dispatchApproved(rewritten, row.payload as Row);
    assertEquals(sends.length, 0, `nothing sent for ${JSON.stringify(rewritten)}`);
    assertEquals(scheduled.status, "error");
    assertEquals(scheduled.error_detail, APPROVED_DRAFT_CHANGED_DETAIL);
  }
});

Deno.test("an approval with no recorded copy of the draft (queued before this check) is not sent", async () => {
  const legacy = { v: 1, data: await harness.encryptToken(JSON.stringify({ draft_id: DRAFT_ID, inbox_id: harness.INBOX_ID, base_revision: 0 })) };
  const { sends, scheduled } = await dispatchApproved(ORIGINAL, legacy);
  assertEquals(sends.length, 0);
  assertEquals(scheduled.status, "error");
  assertEquals(scheduled.error_detail, APPROVED_DRAFT_UNVERIFIED_DETAIL);
});

Deno.test("a draft send on an inbox without approval is sent at once, with no extra read", async () => {
  const { handler, sends } = gmail(ORIGINAL);
  const { world } = await harness.runTool(await harness.inboxRow("gmail"), handler, () =>
    server.dispatchExecutor("draft_send", { inbox_id: harness.INBOX_ID, draft_id: DRAFT_ID }, harness.API_KEY));
  assertEquals(sends.length, 1);
  assert(!world.db.some((c) => c.target === "send_approvals"), "no approval involved");
  assert(!world.calls.some((c) => c.url.includes("format=raw")), "the snapshot read happens only for a held send");
});

// ---------------------------------------------------------------------------
// Follow-ups (verification of 2026-10-16): Reply-To / From / threading are in
// the digest; an Outlook attachment list that will not load is held, not
// failed as "changed"; attachment order is not a change.
// ---------------------------------------------------------------------------

Deno.test("a Reply-To, From or threading header changed after approval is not sent", async () => {
  const queued: FakeDraft = {
    ...ORIGINAL,
    inReplyTo: "<orig-1@example.com>",
    references: "<root@example.com> <orig-1@example.com>",
  };
  const { row, payload } = await holdDraftSend(queued);
  assertEquals((payload.draft_snapshot as Row).reply_to, [], "no Reply-To recorded");
  for (
    const rewritten of [
      { ...queued, replyTo: "drop@evil.example" },
      { ...queued, from: "Someone Else <else@example.com>" },
      { ...queued, inReplyTo: "<other@example.com>" },
      { ...queued, references: "<root@example.com>" },
    ]
  ) {
    const { sends, scheduled } = await dispatchApproved(rewritten, row.payload as Row);
    assertEquals(sends.length, 0, `nothing sent for ${JSON.stringify(rewritten)}`);
    assertEquals(scheduled.error_detail, APPROVED_DRAFT_CHANGED_DETAIL);
  }
  // The same draft with its References folded differently is not a change.
  const refolded = { ...queued, references: "<root@example.com>\r\n <orig-1@example.com>" };
  const { sends } = await dispatchApproved(refolded, row.payload as Row);
  assertEquals(sends.length, 1, "refolded References is the same draft");
});

Deno.test("a Reply-To present when the send was held is recorded for the reviewer", async () => {
  const { payload } = await holdDraftSend({ ...ORIGINAL, replyTo: "Desk <desk@example.com>" });
  assertEquals((payload.draft_snapshot as Row).reply_to, ["Desk <desk@example.com>"]);
});

const OUTLOOK_ID = "AAMkFollowup4242";

interface GraphState {
  replyTo?: string;
  attachments: { name: string; size: number; contentType: string }[];
  /** Attachment-list requests that answer 500 (not retried by graphFetch itself) before one succeeds. */
  failAttachmentLists: number;
  reverseOrderOnRead?: number;
}

function graph(state: GraphState) {
  const sends: string[] = [];
  let attachmentReads = 0;
  const handler: harness.ProviderHandler = (call) => {
    const url = new URL(call.url);
    const base = `/v1.0/me/messages/${OUTLOOK_ID}`;
    if (url.pathname === base && call.method === "GET") {
      return harness.json({
        id: OUTLOOK_ID,
        subject: "Q3 notes",
        body: { contentType: "text", content: "See you Thursday." },
        hasAttachments: state.attachments.length > 0,
        conversationId: "conv-1",
        lastModifiedDateTime: "2026-10-15T10:00:00Z",
        toRecipients: [{ emailAddress: { address: "partner@example.com", name: "Partner" } }],
        ccRecipients: [],
        bccRecipients: [],
        from: { emailAddress: { address: "owner@outlook-harness.example", name: "Harness Owner" } },
        replyTo: state.replyTo ? [{ emailAddress: { address: state.replyTo } }] : [],
      });
    }
    if (url.pathname === `${base}/attachments` && call.method === "GET") {
      attachmentReads++;
      if (state.failAttachmentLists > 0) {
        state.failAttachmentLists--;
        return harness.json({ error: { code: "InternalServerError" } }, 500);
      }
      const list = attachmentReads === state.reverseOrderOnRead ? [...state.attachments].reverse() : state.attachments;
      return harness.json({ value: list });
    }
    if (url.pathname === `${base}/send` && call.method === "POST") {
      sends.push(call.url);
      return new Response(null, { status: 202 });
    }
    return harness.json({ error: { code: "ErrorItemNotFound" } }, 404);
  };
  return { handler, sends };
}

const TWO_FILES = [
  { name: "b.pdf", size: 10, contentType: "application/pdf" },
  { name: "a.pdf", size: 20, contentType: "application/pdf" },
];

async function holdOutlook(state: GraphState) {
  const inbox = await harness.inboxRow("outlook", { send_approval_required: true });
  const { handler } = graph(state);
  const { value, world } = await harness.runTool(inbox, handler, () =>
    server.dispatchExecutor("draft_send", { inbox_id: harness.INBOX_ID, draft_id: OUTLOOK_ID }, harness.API_KEY));
  const insert = world.db.find((c) => c.method === "POST" && c.target === "send_approvals");
  return { value, insert: insert ? insert.body as Row : null };
}

async function dispatchOutlook(state: GraphState, storedPayload: Row) {
  const inbox = await harness.inboxRow("outlook", { send_approval_required: true });
  const { handler, sends } = graph(state);
  return { sends, ...(await dispatchWith(inbox, handler, storedPayload)) };
}

Deno.test("Outlook: attachments listed in another order on the re-read are the same draft", async () => {
  const { insert } = await holdOutlook({ attachments: TWO_FILES, failAttachmentLists: 0 });
  assert(insert);
  const { sends, scheduled } = await dispatchOutlook(
    { attachments: TWO_FILES, failAttachmentLists: 0, reverseOrderOnRead: 1 },
    insert.payload as Row,
  );
  assertEquals(sends.length, 1);
  assertEquals(scheduled.status, "sent");
});

Deno.test("Outlook: one failed attachment-list read is retried and the approved send goes out", async () => {
  const { insert } = await holdOutlook({ attachments: TWO_FILES, failAttachmentLists: 1 });
  assert(insert, "the retry let the queue record the files");
  const recorded = ((await decryptStored(String((insert.payload as Row).data))).draft_snapshot as Row).attachments as Row[];
  assertEquals(recorded.length, 2, "both files recorded, not an empty list");
  const { sends, scheduled } = await dispatchOutlook({ attachments: TWO_FILES, failAttachmentLists: 1 }, insert.payload as Row);
  assertEquals(sends.length, 1);
  assertEquals(scheduled.status, "sent");
});

Deno.test("Outlook: an attachment list that will not load at queue time refuses to queue, nothing recorded as empty", async () => {
  const { value, insert } = await holdOutlook({ attachments: TWO_FILES, failAttachmentLists: 2 });
  assertEquals(insert, null, "no approval of a draft read without its files");
  assert((value as { result?: { isError?: boolean } } | null)?.result?.isError === true);
});

Deno.test("Outlook: an attachment list that will not load at dispatch holds the send for a retry, it is not 'changed'", async () => {
  const { insert } = await holdOutlook({ attachments: TWO_FILES, failAttachmentLists: 0 });
  assert(insert);
  const { sends, scheduled } = await dispatchOutlook({ attachments: TWO_FILES, failAttachmentLists: 2 }, insert.payload as Row);
  assertEquals(sends.length, 0, "nothing sent");
  assertEquals(scheduled.status, "pending", "back on the queue for the next tick");
  assertEquals(scheduled.error_detail, `deferred, nothing was sent: ${APPROVED_DRAFT_UNREADABLE_DETAIL}`);
});

Deno.test("Outlook: a Reply-To added after approval is not sent", async () => {
  const { insert } = await holdOutlook({ attachments: [], failAttachmentLists: 0 });
  assert(insert);
  const { sends, scheduled } = await dispatchOutlook(
    { attachments: [], failAttachmentLists: 0, replyTo: "drop@evil.example" },
    insert.payload as Row,
  );
  assertEquals(sends.length, 0);
  assertEquals(scheduled.error_detail, APPROVED_DRAFT_CHANGED_DETAIL);
});

Deno.test("IMAP: the approved send checks the digest on the exact bytes it is about to send", async () => {
  // No fake IMAP+SMTP pair covers imapSendDraft end to end, so this pins the
  // wiring; the check itself is the tested checkApprovedDraft + draftDigest.
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const send = src.slice(src.indexOf("async function imapSendDraft("), src.indexOf("async function imapDeleteDraft("));
  const fetched = send.indexOf("rawMime = msg.raw;");
  const verified = send.indexOf("if (verify) await verify(rawMime);");
  const smtp = send.indexOf("await imapSmtpSend(inbox, sentMime, recipients);");
  assert(fetched > 0 && verified > fetched && smtp > verified, "verify runs on the fetched bytes, before SMTP");
  const caller = src.slice(src.indexOf("async function executeSendDraft("), src.indexOf("async function executeDeleteDraft("));
  assert(caller.includes("await draftDigest(draftContentFromRaw(rawMime))"), "the same digest over the same bytes");
  assert(caller.includes('if (message === "approved_draft_changed" || message === "approved_draft_unverified")'));
});

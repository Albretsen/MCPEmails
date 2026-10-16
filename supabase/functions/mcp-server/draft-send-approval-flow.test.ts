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
import { APPROVED_DRAFT_CHANGED_DETAIL, APPROVED_DRAFT_UNVERIFIED_DETAIL } from "./draft-send-snapshot.ts";

// The harness has already imported index.ts against its fake network; this is
// the same module instance.
const server = await import("./index.ts");

type Row = Record<string, unknown>;

const DRAFT_ID = "r-4242";
const APPROVAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SEND_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface FakeDraft {
  to: string;
  bcc?: string;
  subject: string;
  text: string;
}

function rawMime(d: FakeDraft): string {
  return [
    "From: Harness Owner <owner@gmail-harness.example>",
    `To: ${d.to}`,
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
  const inbox = await approvalInbox();
  const tables: Record<string, Row[]> = {
    scheduled_sends: [{
      id: SEND_ID,
      inbox_id: harness.INBOX_ID,
      status: "pending",
      payload: { approval_id: APPROVAL_ID },
      payload_encrypted: false,
      send_at: "2020-01-01T00:00:00.000Z",
      updated_at: "2020-01-01T00:00:00.000Z",
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
    }],
    api_keys: [{ ...harness.API_KEY, deleted_at: null }],
    inboxes: [{ ...inbox, deleted_at: null }],
  };
  const { handler, sends } = gmail(draft);
  await harness.runTool(inbox, handler, async () => {
    // deno-lint-ignore no-explicit-any
    const response = await server.handleScheduledDispatch(recordingClient(tables) as any);
    await response.body?.cancel();
  });
  return { sends, scheduled: tables.scheduled_sends[0] };
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

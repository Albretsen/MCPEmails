// ---------------------------------------------------------------------------
// Independent verification (security review 2026-10-16, u06-approvals).
//
// Two questions about the held draft-send digest (draft-send-snapshot.ts):
//
//   1. Can a LEGITIMATE, untouched draft fail it? A digest over anything a
//      provider regenerates on its own (MIME boundary, Date, Message-ID, header
//      order, line folding) would make every approved draft send fail. These
//      tests feed the real raw reader the same draft serialised differently,
//      and run an untouched Outlook draft through queue + approved dispatch.
//   2. Can the CALLER steer it? A tool caller that passes its own
//      `draft_digest` / `draft_snapshot` arguments must not decide what the
//      approval records.
//
// Only the network is fake (provider-call-harness). Nothing is sent anywhere;
// every address is a reserved example domain.
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import * as harness from "./provider-call-harness.ts";
import { APPROVED_DRAFT_CHANGED_DETAIL, draftDigest } from "./draft-send-snapshot.ts";

const server = await import("./index.ts");
const { draftContentFromRaw } = server;

type Row = Record<string, unknown>;

// ── 1a. The raw reader (IMAP, Gmail editor reader) ─────────────────────────

function multipart(opts: {
  boundary: string;
  date: string;
  messageId: string;
  headerOrder?: "a" | "b";
  bcc?: string;
  fileB64?: string;
  eol?: string;
}): string {
  const eol = opts.eol ?? "\r\n";
  const fileB64 = opts.fileB64 ?? "SGVsbG8sIHdvcmxkIQ=="; // "Hello, world!"
  const a = [
    "From: Owner <owner@example.com>",
    "To: Partner <partner@example.com>",
    ...(opts.bcc ? [`Bcc: ${opts.bcc}`] : []),
    "Subject: =?UTF-8?Q?Q3_notes_=E2=80=94_final?=",
  ];
  const b = [
    `Date: ${opts.date}`,
    `Message-ID: <${opts.messageId}>`,
    "MIME-Version: 1.0",
  ];
  const head = opts.headerOrder === "b" ? [...b, ...a] : [...a, ...b];
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${opts.boundary}"`,
    "",
    `--${opts.boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    "See you Thursday.",
    `--${opts.boundary}`,
    'Content-Type: text/plain; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    fileB64,
    `--${opts.boundary}--`,
    "",
  ].join(eol);
}

const BASE = {
  boundary: "=_b1_aaaaaaaa",
  date: "Thu, 15 Oct 2026 10:00:00 +0000",
  messageId: "draft-1@example.com",
};

Deno.test("verify: an untouched draft re-serialised by its server (boundary, Date, Message-ID, header order, LF) keeps its digest", async () => {
  const original = await draftDigest(draftContentFromRaw(multipart(BASE)));
  for (
    const variant of [
      { ...BASE, boundary: "----=_Part_99_123456.789" },
      { ...BASE, date: "Fri, 16 Oct 2026 08:30:00 +0200" },
      { ...BASE, messageId: "regenerated-77@example.com" },
      { ...BASE, headerOrder: "b" as const },
      { ...BASE, eol: "\n" },
    ]
  ) {
    assertEquals(
      await draftDigest(draftContentFromRaw(multipart(variant))),
      original,
      `digest moved for ${JSON.stringify(variant)}`,
    );
  }
});

Deno.test("verify: a Bcc added, or a file's bytes swapped at the same size, changes the raw digest", async () => {
  const original = await draftDigest(draftContentFromRaw(multipart(BASE)));
  assertNotEquals(
    await draftDigest(draftContentFromRaw(multipart({ ...BASE, bcc: "drop@evil.example" }))),
    original,
  );
  // "Hello, WORLD!" — same length as "Hello, world!"
  assertNotEquals(
    await draftDigest(draftContentFromRaw(multipart({ ...BASE, fileB64: "SGVsbG8sIFdPUkxEIQ==" }))),
    original,
  );
});

// ── 1b + 2. Queue + approved dispatch through the real executor ────────────

const DRAFT_ID = "AAMkAGraphDraft4242";
const APPROVAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SEND_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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

interface GraphDraft {
  attachmentsFail?: boolean;
  to: string;
  bcc?: string;
  subject: string;
  html: string;
  attachments: { name: string; size: number; contentType: string }[];
}

/** A Graph that holds one draft and records /send calls. */
function graph(draft: GraphDraft) {
  const sends: string[] = [];
  const handler: harness.ProviderHandler = (call) => {
    const url = new URL(call.url);
    const base = `/v1.0/me/messages/${DRAFT_ID}`;
    if (url.pathname === base && call.method === "GET") {
      return harness.json({
        id: DRAFT_ID,
        subject: draft.subject,
        body: { contentType: "html", content: draft.html },
        hasAttachments: draft.attachments.length > 0,
        conversationId: "conv-4242",
        lastModifiedDateTime: "2026-10-15T10:00:00Z",
        toRecipients: [{ emailAddress: { address: draft.to, name: "Partner" } }],
        ccRecipients: [],
        bccRecipients: draft.bcc ? [{ emailAddress: { address: draft.bcc } }] : [],
      });
    }
    if (url.pathname === `${base}/attachments` && call.method === "GET") {
      if (draft.attachmentsFail) return harness.json({ error: { code: "ServiceUnavailable" } }, 503);
      return harness.json({ value: draft.attachments });
    }
    if (url.pathname === `${base}/send` && call.method === "POST") {
      sends.push(call.url);
      return new Response(null, { status: 202 });
    }
    return harness.json({ error: { code: "ErrorItemNotFound" } }, 404);
  };
  return { handler, sends };
}

async function holdOutlook(draft: GraphDraft, args: Row = {}) {
  const inbox = await harness.inboxRow("outlook", { send_approval_required: true });
  const { handler } = graph(draft);
  const { world } = await harness.runTool(inbox, handler, () =>
    server.dispatchExecutor(
      "draft_send",
      { inbox_id: harness.INBOX_ID, draft_id: DRAFT_ID, ...args },
      harness.API_KEY,
    ));
  const insert = world.db.find((c) => c.method === "POST" && c.target === "send_approvals");
  assert(insert, "an approval row was written");
  const row = insert.body as Row;
  return { row, payload: await decryptStored(String((row.payload as Row).data)) };
}

async function dispatchOutlook(draft: GraphDraft, storedPayload: Row, sendAt = "2020-01-01T00:00:00.000Z") {
  const inbox = await harness.inboxRow("outlook", { send_approval_required: true });
  const tables: Record<string, Row[]> = {
    scheduled_sends: [{
      id: SEND_ID,
      inbox_id: harness.INBOX_ID,
      status: "pending",
      payload: { approval_id: APPROVAL_ID },
      payload_encrypted: false,
      send_at: sendAt,
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
  const { handler, sends } = graph(draft);
  await harness.runTool(inbox, handler, async () => {
    // deno-lint-ignore no-explicit-any
    const response = await server.handleScheduledDispatch(recordingClient(tables) as any);
    await response.body?.cancel();
  });
  return { sends, scheduled: tables.scheduled_sends[0] };
}

const OUTLOOK_DRAFT: GraphDraft = {
  to: "partner@example.com",
  subject: "Q3 notes",
  html: '<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body><p>See you Thursday.</p></body></html>',
  attachments: [{ name: "notes.pdf", size: 2048, contentType: "application/pdf" }],
};

Deno.test("verify: an untouched Outlook (Graph) draft is sent after approval", async () => {
  const { payload } = await holdOutlook(OUTLOOK_DRAFT);
  assert(/^[0-9a-f]{64}$/.test(String(payload.draft_digest)));
  const snapshot = payload.draft_snapshot as Row;
  assert(String(snapshot.body_html).includes("See you Thursday."));
  assertEquals((snapshot.attachments as Row[]).map((a) => a.filename), ["notes.pdf"]);
  const { row } = await holdOutlook(OUTLOOK_DRAFT);
  const { sends, scheduled } = await dispatchOutlook(OUTLOOK_DRAFT, row.payload as Row);
  assertEquals(sends.length, 1, "Graph /send was called");
  assertEquals(scheduled.status, "sent");
});

Deno.test("verify: an Outlook draft given a Bcc after approval is not sent", async () => {
  const { row } = await holdOutlook(OUTLOOK_DRAFT);
  const { sends, scheduled } = await dispatchOutlook({ ...OUTLOOK_DRAFT, bcc: "drop@evil.example" }, row.payload as Row);
  assertEquals(sends.length, 0);
  assertEquals(scheduled.status, "error");
  assertEquals(scheduled.error_detail, APPROVED_DRAFT_CHANGED_DETAIL);
});

Deno.test("verify: a caller cannot supply the digest or snapshot a held send records", async () => {
  const evil: GraphDraft = { ...OUTLOOK_DRAFT, bcc: "drop@evil.example", html: "<p>harvested</p>" };
  const evilDigest = "0".repeat(64);
  const { row, payload } = await holdOutlook(OUTLOOK_DRAFT, {
    draft_digest: evilDigest,
    draft_snapshot: { v: 1, to: ["partner@example.com"], cc: [], bcc: [], subject: "Q3 notes", body_text: "fine", body_html: null, body_truncated: false, attachments: [] },
  });
  assertNotEquals(payload.draft_digest, evilDigest, "the server's digest, not the caller's");
  assert(String((payload.draft_snapshot as Row).body_html).includes("See you Thursday."), "the server's own read");
  const { sends } = await dispatchOutlook(evil, row.payload as Row);
  assertEquals(sends.length, 0, "the rewritten draft is not sent");
});

// ── Delta ce1eb3dd: digest v2 and the unreadable-draft hold ────────────────

Deno.test("verify v2: genuinely different drafts never collide (Reply-To, file bytes moved between names, In-Reply-To)", async () => {
  const base = { to: ["a@example.com"], cc: [], bcc: [], subject: "s", bodyText: "b", bodyHtml: null };
  const files = (pairs: [string, string][]) => ({
    encode: () => pairs.map(([filename, data]) => ({ filename, mime_type: "text/plain", data })),
  });
  const att = [
    { filename: "a.txt", size_bytes: 4, mime_type: "text/plain" },
    { filename: "b.txt", size_bytes: 4, mime_type: "text/plain" },
  ];
  const d = (extra: Record<string, unknown>) => draftDigest({ ...base, attachments: att, ...extra });
  const original = await d({ carried: files([["a.txt", "QUFBQQ=="], ["b.txt", "QkJCQg=="]]) });
  // Same files in the other order: the same draft.
  assertEquals(await d({ carried: files([["b.txt", "QkJCQg=="], ["a.txt", "QUFBQQ=="]]), attachments: [...att].reverse() }), original);
  // Bytes moved between the two names: a different draft.
  assertNotEquals(await d({ carried: files([["a.txt", "QkJCQg=="], ["b.txt", "QUFBQQ=="]]) }), original);
  assertNotEquals(await d({ carried: files([["a.txt", "QUFBQQ=="], ["b.txt", "QkJCQg=="]]), headerReplyTo: ["drop@evil.example"] }), original);
  assertNotEquals(await d({ carried: files([["a.txt", "QUFBQQ=="], ["b.txt", "QkJCQg=="]]), inReplyTo: "<x@example.com>" }), original);
  // A References list folded differently is the same list; a different list is not.
  const r1 = await d({ references: "<a@x> <b@x>" });
  assertEquals(await d({ references: "<a@x>\r\n <b@x>" }), r1);
  assertNotEquals(await d({ references: "<a@x> <c@x>" }), r1);
});

Deno.test("verify v2: an Outlook draft unreadable at dispatch is held inside the window and failed after it, never sent", async () => {
  const { row } = await holdOutlook(OUTLOOK_DRAFT);
  const unreadable = { ...OUTLOOK_DRAFT, attachmentsFail: true };
  const fresh = await dispatchOutlook(unreadable, row.payload as Row, new Date().toISOString());
  assertEquals(fresh.sends.length, 0);
  assertEquals(fresh.scheduled.status, "pending", "held for a retry inside the defer window");
  const stale = await dispatchOutlook(unreadable, row.payload as Row, "2020-01-01T00:00:00.000Z");
  assertEquals(stale.sends.length, 0);
  assertEquals(stale.scheduled.status, "error", "the hold is bounded: past the window it fails for real");
});

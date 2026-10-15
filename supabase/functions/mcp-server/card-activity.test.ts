// ---------------------------------------------------------------------------
// What the person did in the draft editor card reaches the model through the
// server (QA 2026-10-15). card-activity.ts, its wiring in mcp-app-drafts.ts and
// index.ts, and the receipt wording that came out of the same QA run.
//
// The QA report these pin: after a save in the card Claude still reported the
// old subject and recipients; after a send from the card Claude said "No, I
// never sent it"; the receipt said "Delivered" for a message that went to
// spam, and named "IMAP + SMTP" twice.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  alreadySentText,
  type CardActivityEvent,
  cardActivityNote,
  cardSendOf,
  closedBySendText,
  FakeCardActivityStore,
  noteCarrier,
  recordCardActivity,
  takeCardActivityNote,
} from "./card-activity.ts";
import {
  type DraftEditorCaller,
  type DraftEditorDeps,
  type DraftEditorProviderInbox,
  type DraftEditorToolResult,
  DRAFT_SENT_RECEIPT_DETAIL,
  type ProviderDraft,
  runDraftEditorSave,
  runDraftRead,
} from "./mcp-app-drafts.ts";
import { closeDraftLine, recordDraftWrite, resolveDraftId } from "./draft-lineage.ts";
import { memoryLineageStore } from "./draft-lineage-fake.ts";

const S = { workspaceId: "ws-1", inboxId: "inbox-1" };
const quiet = () => {};
const NOW = Date.parse("2026-10-15T12:00:00Z");

const saved = (over: Partial<CardActivityEvent> = {}): CardActivityEvent => ({
  draftId: "Drafts:7",
  lineId: "line-1",
  action: "saved",
  occurredAt: "2026-10-15T11:58:00.123Z",
  revision: 2,
  fields: ["to", "subject"],
  toCount: 2,
  ccCount: 0,
  bccCount: 0,
  ...over,
});

// ── The note ────────────────────────────────────────────────────────────────

Deno.test("the note states a save and a send, oldest first, with no content", () => {
  const note = cardActivityNote([
    saved({ draftId: "Drafts:8", action: "sent", occurredAt: "2026-10-15T11:59:30Z", fields: [], toCount: null, ccCount: null, bccCount: null }),
    saved(),
  ]);
  assertEquals(
    note,
    "Since the last draft result for this inbox, the user acted in the MCP Emails draft editor card, " +
      "which is not shown to you. " +
      "At 2026-10-15T11:58:00Z the user saved draft Drafts:7 in the card, changing the subject and To. " +
      "Its recipients are now to 2, cc 0, bcc 0. " +
      "At 2026-10-15T11:59:30Z the user sent draft Drafts:8 from the card. " +
      "It is no longer a draft and that draft_id no longer resolves. " +
      "draft_read returns a saved draft's current subject, recipients and text.",
  );
});

Deno.test("a send alone does not point at draft_read, and nothing is a note of nothing", () => {
  const note = cardActivityNote([saved({ action: "sent", fields: [], toCount: null, ccCount: null, bccCount: null })])!;
  assert(!note.includes("draft_read"), note);
  assert(note.includes("the user sent draft Drafts:7 from the card"), note);
  assertEquals(cardActivityNote([]), null);
});

Deno.test("a long burst lists the newest five and counts the rest", () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    saved({ draftId: `Drafts:${i}`, occurredAt: new Date(NOW - (7 - i) * 1000).toISOString() })
  );
  const note = cardActivityNote(rows)!;
  assert(!note.includes("Drafts:0 ") && !note.includes("Drafts:1 "), note);
  assert(note.includes("Drafts:6"), note);
  assert(note.includes("2 earlier card actions are not listed."), note);
});

// ── Said once ──────────────────────────────────────────────────────────────

Deno.test("each card action is told once, to the inbox it happened in, and only while recent", async () => {
  const store = new FakeCardActivityStore();
  await recordCardActivity(store, S, saved({ occurredAt: new Date(NOW - 60_000).toISOString() }), quiet);
  await recordCardActivity(store, { ...S, inboxId: "inbox-2" }, saved({ draftId: "Drafts:99" }), quiet);
  await recordCardActivity(store, S, saved({ draftId: "old", occurredAt: new Date(NOW - 25 * 3600_000).toISOString() }), quiet);

  const first = await takeCardActivityNote(store, S, NOW, quiet);
  assert(first?.includes("Drafts:7"), String(first));
  assert(!first!.includes("Drafts:99"), "another inbox's action is not this inbox's news");
  assert(!first!.includes("draft old"), "a day-old action is not news");
  assertEquals(await takeCardActivityNote(store, S, NOW, quiet), null, "said once");
});

Deno.test("fail soft: a database without the table records nothing, notes nothing, throws nothing", async () => {
  const store = new FakeCardActivityStore();
  store.failing = true;
  const logged: string[] = [];
  await recordCardActivity(store, S, saved(), (e) => logged.push(e));
  assertEquals(await takeCardActivityNote(store, S, NOW, (e) => logged.push(e)), null);
  assertEquals(await cardSendOf(store, S, { lineId: null, draftId: "x" }, (e) => logged.push(e)), null);
  assertEquals(logged, [
    "draft_card_activity_record_failed",
    "draft_card_activity_claim_failed",
    "draft_card_activity_lookup_failed",
  ]);
  assertEquals(await takeCardActivityNote(null, S, NOW), null);
});

// ── Which results carry it ────────────────────────────────────────────────

Deno.test("only the model's own draft calls carry the note, never a call the card makes", () => {
  const model = { approvalDispatch: false };
  for (const name of ["draft_list", "draft_create", "draft_reply", "draft_update"]) {
    assertEquals(noteCarrier(name, {}, model), true, name);
  }
  assertEquals(noteCarrier("draft_send", { draft_id: "d" }, model), true, "the model's send");
  assertEquals(noteCarrier("draft_send", { draft_id: "d", base_revision: 3 }, model), false, "the card's send");
  assertEquals(noteCarrier("draft_send", { draft_id: "d", base_revision: 0 }, model), false, "a card send at 0");
  // The card calls these, and the host shows the model none of their results.
  for (const name of ["draft_read", "draft_editor_save", "draft_editor_hide", "draft_delete", "approval_decide", "email_search"]) {
    assertEquals(noteCarrier(name, {}, model), false, name);
  }
  assertEquals(noteCarrier("draft_list", {}, { approvalDispatch: true }), false, "an approved re-run");
});

// ── "Already sent" says by whom and when ────────────────────────────────────

Deno.test("the already-sent refusal names the card and the time when the card sent it", () => {
  assertEquals(
    alreadySentText({ requestedId: "Drafts:7", sentCopyKept: false, cardSentAt: "2026-10-15T11:59:30.500Z", closedAt: "2026-10-15T11:59:31Z" }),
    "draft_send: draft Drafts:7 was already sent by the user from the MCP Emails draft editor card at " +
      "2026-10-15T11:59:30Z. Nothing was sent again.",
  );
  assertEquals(
    alreadySentText({ requestedId: "Drafts:7", sentCopyKept: true, cardSentAt: null, closedAt: "2026-10-15T11:59:31Z" }),
    "draft_send: draft Drafts:7 was already sent at 2026-10-15T11:59:31Z, and its copy is still in the " +
      "Drafts folder. Nothing was sent again.",
  );
  assertEquals(
    alreadySentText({ requestedId: "Drafts:7", sentCopyKept: false, cardSentAt: null, closedAt: null }),
    "draft_send: draft Drafts:7 was already sent. Nothing was sent again.",
  );
});

// ── Wired into the editor's own tools ────────────────────────────────────────

const INBOX: DraftEditorProviderInbox = {
  id: "inbox-1",
  email_address: "you@example.com",
  display_name: "You",
  provider: "imap",
  service: null,
  signature_enabled: false,
  signature_text: null,
  signature_html: null,
};

const CALLER: DraftEditorCaller = {
  id: "key-1",
  workspace_id: "ws-1",
  scopes: ["manage:drafts", "read:email", "send:email"],
  inbox_ids: null,
  user_id: "user-1",
};

function mailbox() {
  const drafts = new Map<string, ProviderDraft>();
  const { store } = memoryLineageStore();
  const activity = new FakeCardActivityStore();
  const scope = (i: DraftEditorProviderInbox) => ({ workspaceId: CALLER.workspace_id, inboxId: i.id });
  let nextUid = 1;
  let clock = NOW;
  const deps: DraftEditorDeps = {
    appUrl: "https://mcpemails.com",
    workspaceGate: () => Promise.resolve({ rolledOut: true, hidden: false }),
    inboxHidden: () => Promise.resolve(false),
    workspaceRole: () => Promise.resolve("owner"),
    resolveInbox: () => Promise.resolve({ ok: true as const, inbox: INBOX }),
    getDraft: (_i, id) => Promise.resolve(drafts.get(id) ?? null),
    updateDraft: (_i, id, params) => {
      if (!drafts.has(id)) return Promise.reject(new Error("draft_not_found"));
      drafts.delete(id);
      const newId = `Drafts:${nextUid++}`;
      drafts.set(newId, {
        subject: params.subject,
        to: params.to,
        cc: params.cc,
        bcc: params.bcc,
        bodyText: params.body,
        bodyHtml: params.htmlBody ?? null,
        attachments: [],
      });
      return Promise.resolve({ draft_id: newId });
    },
    isValidEmailAddress: (a: string) => /^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(a),
    setDraftEditorHidden: () => Promise.resolve(),
    lineage: {
      resolve: (i, id) => resolveDraftId(store, scope(i), id, quiet),
      recordWrite: (i, previous, id, writtenBy, at) =>
        recordDraftWrite(store, scope(i), { previous, draftId: id, writtenBy, at }, quiet),
    },
    cardActivity: {
      record: (i, event) => recordCardActivity(activity, scope(i), event, quiet),
      lastSent: (i, target) => cardSendOf(activity, scope(i), target, quiet),
    },
    now: () => (clock += 1000),
  };
  const create = async () => {
    const id = `Drafts:${nextUid++}`;
    drafts.set(id, { subject: "Old subject", to: ["a@x.com"], cc: [], bcc: [], bodyText: "Hi", bodyHtml: null, attachments: [] });
    await recordDraftWrite(store, scope(INBOX), { previous: null, draftId: id, writtenBy: "agent", at: new Date(clock).toISOString() }, quiet);
    return id;
  };
  /** What executeSendDraft does on a card send that went out. */
  const cardSends = async (id: string, at: string) => {
    const line = await resolveDraftId(store, scope(INBOX), id, quiet);
    drafts.delete(line.draftId);
    await closeDraftLine(store, scope(INBOX), line, "sent", at, quiet);
    await recordCardActivity(activity, scope(INBOX), {
      draftId: line.draftId, lineId: line.lineId, action: "sent", occurredAt: at,
      revision: line.revision, fields: [], toCount: null, ccCount: null, bccCount: null,
    }, quiet);
  };
  return { deps, activity, create, cardSends };
}

const text = (out: DraftEditorToolResult) => out.result.content.map((c) => c.text).join(" ");

Deno.test("a save in the card is recorded, field names and counts only, and the model's next draft result says so", async () => {
  const m = mailbox();
  const id = await m.create();
  const out = await runDraftEditorSave(m.deps, CALLER, {
    draft_id: id,
    subject: "Secret new subject",
    to: ["a@x.com", "b@x.com"],
  });
  assertEquals(out.result.isError, false);
  assertEquals(m.activity.rows.length, 1);
  const row = m.activity.rows[0];
  assertEquals([row.action, row.fields, row.toCount, row.ccCount, row.bccCount], ["saved", ["subject", "to"], 2, 0, 0]);
  assert(!JSON.stringify(row).includes("Secret"), "no subject is stored");
  assert(!JSON.stringify(row).includes("b@x.com"), "no address is stored");

  const note = await takeCardActivityNote(m.activity, S, NOW + 60_000, quiet);
  assert(note?.includes(`the user saved draft ${row.draftId} in the card, changing the subject and To.`), String(note));
});

Deno.test("a save that changes nothing records nothing", async () => {
  const m = mailbox();
  const id = await m.create();
  await runDraftEditorSave(m.deps, CALLER, { draft_id: id, subject: "Old subject" });
  assertEquals(m.activity.rows.length, 0);
});

Deno.test("draft_read of a draft the card sent tells the model it was sent, by whom and when", async () => {
  const m = mailbox();
  const id = await m.create();
  await m.cardSends(id, "2026-10-15T12:05:00Z");
  const out = await runDraftRead(m.deps, CALLER, { draft_id: id });
  assertEquals(out.result.isError, true);
  assertEquals(
    text(out),
    closedBySendText({ draftId: id, cardSentAt: "2026-10-15T12:05:00Z", closedAt: null }),
  );
  assert(text(out).includes("was already sent by the user from the MCP Emails draft editor card at 2026-10-15T12:05:00Z"));
  // The card's receipt is unchanged: same code, same person's words.
  const receipt = (out.result.structuredContent as Record<string, any>).receipt;
  assertEquals([receipt.error_code, receipt.headline], ["draft_not_found", "This draft was already sent."]);
});

Deno.test("draft_read of a draft sent elsewhere still says it was sent, with the lineage's time", async () => {
  const m = mailbox();
  const id = await m.create();
  // Closed by a send that was not the card's (the model's own): no card row.
  await m.cardSends(id, "2026-10-15T12:06:00Z");
  m.activity.rows.length = 0;
  const out = await runDraftRead(m.deps, CALLER, { draft_id: id });
  assertEquals(
    text(out),
    `Draft ${id} was already sent at 2026-10-15T12:06:00Z. It is no longer a draft, so this draft_id ` +
      "no longer resolves. Nothing was changed.",
  );
});

// ── index.ts wiring (it cannot be imported: it serves at module load) ───────

Deno.test("index.ts records the card's send, claims the note for the model's draft calls, and words the refusal", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const send = src.slice(src.indexOf("async function executeSendDraft("), src.indexOf("async function executeDeleteDraft("));
  assert(send.includes("alreadySentText({"), "the refusal says who and when");
  assert(
    /baseRevision !== null && apiKey\.internalApprovalDispatch !== true\s*\?\s*recordCardActivity\(/.test(send),
    "a card send is recorded, an approved re-run is not",
  );
  assert(send.includes("DRAFT_SENT_RECEIPT_DETAIL"), "the receipt detail is the shared constant");
  assert(!send.includes("`Delivered via"), "no more 'Delivered via'");

  const dispatch = src.slice(src.indexOf("async function dispatchExecutor("), src.indexOf("async function runExecutor("));
  assert(dispatch.includes("noteCarrier(dispatchName, rawArgs"), "only carriers");
  assert(dispatch.includes("takeCardActivityNote("), "the note is claimed");
  assert(dispatch.includes("noteForResult(note)"), "and attached with the other result notes");

  const deps = src.slice(src.indexOf("function draftEditorDepsFor("), src.indexOf("function draftEditorCallerFor("));
  assert(deps.includes("cardActivity: {"), "the editor's tools get the port");

  // The `draft` tool tells the model the card can act without it, and to re-read.
  assert(
    src.includes(
      '"change it. The user can also save, send or discard it there without " +\n' +
        '      "you being told, so call draft_read before stating a draft\'s current " +\n' +
        '      "subject, recipients or whether it was sent. " +',
    ),
    "the draft description carries the re-read guidance",
  );
});

Deno.test("the sent receipt says the mail server accepted it, and names no provider", () => {
  assertEquals(DRAFT_SENT_RECEIPT_DETAIL, "Accepted by the mail server for delivery.");
  assert(!/IMAP|SMTP|Gmail|Outlook|Deliver/.test(DRAFT_SENT_RECEIPT_DETAIL));
});

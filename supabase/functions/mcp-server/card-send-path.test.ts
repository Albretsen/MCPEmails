// ---------------------------------------------------------------------------
// The draft editor card's send path, from the live test of 2026-10-26 on a
// Gmail IMAP+SMTP inbox:
//
//   1. the draft stayed in Drafts after Send (draft-removal.ts);
//   2. every Gmail send left two copies in Sent (sent-copy.ts);
//   3. the sent mail carried the draft's original Date (mime-build.ts);
//   4. after Discard in the card the model could not tell what had happened
//      to the draft (card-activity.ts, "deleted").
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  DRAFT_KEPT_AFTER_SEND_NOTE,
  DRAFT_KEPT_RECEIPT_DETAIL,
  type DraftRemovalClient,
  type DraftRemovalMailbox,
  removeSentDraft,
} from "./draft-removal.ts";
import { smtpFilesSentCopyItself } from "./sent-copy.ts";
import { draftSendBytes, setDateHeader } from "./mime-build.ts";
import {
  appendNoteToErrorResult,
  type CardActivityEvent,
  cardActivityNote,
  FakeCardActivityStore,
  goneNoteTargetDraftId,
  peekCardDeletedNote,
  recordCardActivity,
} from "./card-activity.ts";

const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const fnBody = (name: string): string => {
  const start = index.indexOf(`async function ${name}(`);
  assert(start >= 0, `${name} not found`);
  return index.slice(start, index.indexOf("\n}\n", start));
};

// ── 1. Removing the sent draft ────────────────────────────────────────────

/**
 * A Gmail-like server. `merged` reproduces what was seen live: the draft had
 * the \Sent label (our APPEND landed on it), so EXPUNGE from Drafts answered
 * OK and left it, and only `-X-GM-LABELS (\Draft)` in All Mail removed it.
 */
function fakeImap(opts: { gmail: boolean; merged: boolean; throwOn?: string }) {
  const log: string[] = [];
  let selected = "";
  const drafts = new Set([9045]);
  const allMail = new Map([[121348, "1880138338987809320"]]);
  const mailboxes: DraftRemovalMailbox[] = [
    { name: "INBOX", flags: [] },
    { name: "[Gmail]/All Mail", flags: ["\\HasNoChildren", "\\All"] },
    { name: "[Gmail]/Drafts", flags: ["\\Drafts"] },
  ];
  const step = (s: string) => {
    log.push(s);
    if (opts.throwOn && s.startsWith(opts.throwOn)) throw new Error("connection reset");
  };
  const client: DraftRemovalClient = {
    selectMailbox: (m) => (step(`SELECT ${m}`), selected = m, Promise.resolve()),
    uidStore: (uids, flags, mode) => (step(`STORE ${uids} ${mode} ${flags}`), Promise.resolve()),
    uidExpunge: (uids) => {
      step(`EXPUNGE ${uids}`);
      if (!opts.merged) for (const u of uids) drafts.delete(u);
      return Promise.resolve();
    },
    uidSearch: (c) => {
      step(`SEARCH ${c}`);
      if (selected !== "[Gmail]/All Mail") {
        const uid = Number(c.replace("UID ", ""));
        return Promise.resolve(drafts.has(uid) ? [uid] : []);
      }
      const id = c.replace("X-GM-MSGID ", "");
      return Promise.resolve([...allMail].filter(([, m]) => m === id).map(([u]) => u));
    },
    hasCapability: (n) => opts.gmail && n === "X-GM-EXT-1",
    fetchGmailIds: (uids) => (step(`FETCH-GM ${uids}`),
      Promise.resolve([{ uid: uids[0], threadId: "1", messageId: "1880138338987809320" }])),
    listMailboxes: () => (step("LIST"), Promise.resolve(mailboxes)),
    uidStoreGmailLabels: (uids, labels, mode) => {
      step(`LABELS ${uids} ${mode} ${labels}`);
      if (selected === "[Gmail]/All Mail" && mode === "remove" && labels.includes("\\Draft")) drafts.delete(9045);
      return Promise.resolve();
    },
  };
  return { client, log, drafts };
}

Deno.test("sent draft: an ordinary expunge is checked, then reported removed", async () => {
  const { client, log } = fakeImap({ gmail: false, merged: false });
  assertEquals(await removeSentDraft(client, "Drafts", 9045), { removed: true, via: "expunge" });
  assertEquals(log, ["SELECT Drafts", "STORE 9045 add \\Deleted", "EXPUNGE 9045", "SEARCH UID 9045"]);
});

Deno.test("sent draft: Gmail ignoring the expunge (draft also labelled Sent) falls back to the All Mail label", async () => {
  const { client, log, drafts } = fakeImap({ gmail: true, merged: true });
  assertEquals(await removeSentDraft(client, "[Gmail]/Drafts", 9045), { removed: true, via: "gmail_label" });
  assertEquals(drafts.size, 0);
  assert(log.indexOf("FETCH-GM 9045") < log.indexOf("EXPUNGE 9045"), "Gmail id read before the delete");
  assert(log.includes("SELECT [Gmail]/All Mail"));
  assert(log.includes("LABELS 121348 remove \\Draft"));
  assertEquals(log.at(-1), "SEARCH UID 9045", "and checked again in Drafts");
});

Deno.test("sent draft: Gmail removing it on the expunge takes no label route", async () => {
  const { client, log } = fakeImap({ gmail: true, merged: false });
  assertEquals(await removeSentDraft(client, "[Gmail]/Drafts", 9045), { removed: true, via: "expunge" });
  assert(!log.some((l) => l.startsWith("LABELS")));
});

Deno.test("sent draft: a non-Gmail draft that survives the expunge is reported, not assumed gone", async () => {
  const { client } = fakeImap({ gmail: false, merged: true });
  assertEquals(await removeSentDraft(client, "Drafts", 9045), { removed: false, via: "still_present" });
});

Deno.test("sent draft: a failure is reported, never thrown", async () => {
  const { client } = fakeImap({ gmail: false, merged: false, throwOn: "EXPUNGE" });
  const r = await removeSentDraft(client, "Drafts", 9045);
  assertEquals([r.removed, r.via, r.error], [false, "error", "connection reset"]);
});

Deno.test("sent draft: imapSendDraft uses the checked removal and logs a draft left behind", () => {
  const body = fnBody("imapSendDraft");
  assertStringIncludes(body, "const removal = await removeSentDraft(client, folder, uid);");
  assertStringIncludes(body, "draftRemoved = removal.removed;");
  assertStringIncludes(body, "imap_sent_draft_removal");
  assert(!/catch \{\s*\/\/ best-effort/.test(body), "no silent catch any more");
});

Deno.test("sent draft: a draft left behind is told to the model and on the card", () => {
  const body = fnBody("executeSendDraft");
  assertStringIncludes(body, "if (draftRemoved === false) noteForResult(DRAFT_KEPT_AFTER_SEND_NOTE);");
  assertStringIncludes(body, "draftRemoved === false ? DRAFT_KEPT_RECEIPT_DETAIL : DRAFT_SENT_RECEIPT_DETAIL");
  assertStringIncludes(DRAFT_KEPT_RECEIPT_DETAIL, "Sent, but the draft is still in Drafts.");
  assertStringIncludes(DRAFT_KEPT_AFTER_SEND_NOTE, "Do not send it again");
});

// ── 2. One Sent copy on Gmail ─────────────────────────────────────────────

Deno.test("Sent copy: Gmail's SMTP files its own, other servers do not", () => {
  for (const host of ["smtp.gmail.com", "SMTP.GMAIL.COM", " smtp.googlemail.com "]) {
    assertEquals(smtpFilesSentCopyItself(host), true, host);
  }
  for (const host of ["smtp-relay.gmail.com", "smtp.fastmail.com", "mail.gmail.com.evil.test", "", null, undefined]) {
    assertEquals(smtpFilesSentCopyItself(host), false, String(host));
  }
});

Deno.test("Sent copy: appendToSentFolder skips Gmail SMTP, so every APPEND site does", () => {
  const body = fnBody("appendToSentFolder");
  assertStringIncludes(body, "if (smtpFilesSentCopyItself(inbox.smtp_host)) return;");
  assert(body.indexOf("smtpFilesSentCopyItself") < body.indexOf("ImapClient.connect"));
  // The sites that file a Sent copy all go through it (compose, reply, raw
  // transmit, draft send); none APPENDs to Sent on its own.
  assertEquals(index.match(/await appendToSentFolder\(/g)?.length, 4);
});

// ── 3. Date at send time ──────────────────────────────────────────────────

const CRLF = "\r\n";
const DRAFT = [
  "From: owner@example.com",
  "To: owner@example.com",
  "Bcc: hidden@example.com",
  "Date: Mon, 26 Oct 2026 18:34:04 GMT",
  "Message-ID: <draft-1@mcpemails.com>",
  "In-Reply-To: <orig@example.com>",
  "References: <root@example.com>",
  " <orig@example.com>",
  "Subject: Card QA",
  "",
  "Date: in the body stays",
].join(CRLF);

Deno.test("Date: a sent draft is dated when it is sent, threading headers untouched", () => {
  const at = new Date("2026-10-26T19:02:11Z");
  const out = new TextDecoder().decode(draftSendBytes(DRAFT, at));
  assertStringIncludes(out, `Date: ${at.toUTCString()}${CRLF}`);
  assert(!out.includes("18:34:04"));
  assertStringIncludes(out, "Message-ID: <draft-1@mcpemails.com>");
  assertStringIncludes(out, "In-Reply-To: <orig@example.com>");
  assertStringIncludes(out, `References: <root@example.com>${CRLF} <orig@example.com>`);
  assert(!out.toLowerCase().includes("bcc"));
  assert(out.endsWith(`${CRLF}${CRLF}Date: in the body stays`), "the body is not touched");
});

Deno.test("Date: a folded or repeated Date header becomes one line", () => {
  const at = new Date("2026-10-26T19:00:00Z");
  const raw = ["Date: Mon, 26 Oct 2026", " 18:34:04 GMT", "date: Sun, 1 Jan 2026 00:00:00 GMT", "Subject: x", "", "b"].join(CRLF);
  assertEquals(setDateHeader(raw, at), [`Date: ${at.toUTCString()}`, "Subject: x", "", "b"].join(CRLF));
});

Deno.test("Date: a draft without a Date header is left exactly as it is", () => {
  const raw = ["To: a@example.com", "Subject: x", "", "b"].join(CRLF);
  assertEquals(setDateHeader(raw, new Date()), raw);
});

// ── 4. A Discard in the card reaches the model ────────────────────────────

const S = { workspaceId: "ws-1", inboxId: "inbox-1", apiKeyId: "key-1" };
const NOW = Date.parse("2026-10-26T19:00:00Z");
const deleted = (over: Partial<CardActivityEvent> = {}): CardActivityEvent => ({
  draftId: "[Gmail]/Drafts:9046",
  lineId: "line-1",
  action: "deleted",
  occurredAt: "2026-10-26T18:35:56.475Z",
  revision: 1,
  fields: [],
  toCount: null,
  ccCount: null,
  bccCount: null,
  ...over,
});

Deno.test("deleted: the note says the draft was deleted in the editor, never who did it", () => {
  const note = cardActivityNote([deleted()])!;
  assertStringIncludes(note, "At 2026-10-26T18:35:56Z it was deleted there");
  assertStringIncludes(note, "without being sent");
  assert(!/the user (deleted|discarded|removed)/i.test(note), note);
  assert(!note.includes("Drafts:9046"), "no raw id");
});

Deno.test("deleted: a failed model call on that draft gets the note in its error text", async () => {
  const store = new FakeCardActivityStore();
  await recordCardActivity(store, S, deleted());
  const target = { lineId: "line-1", draftIds: ["[Gmail]/Drafts:9046"] };
  const note = await peekCardDeletedNote(store, S, target, { nowMs: NOW });
  assertStringIncludes(note!, "it was deleted there");
  // Read, not claimed: it is still there for the next call.
  assertEquals(await peekCardDeletedNote(store, S, target, { nowMs: NOW }), note);

  const result = { isError: true, content: [{ type: "text", text: "Draft [Gmail]/Drafts:9046 no longer exists." }] };
  appendNoteToErrorResult(result, note!);
  assertEquals(result.content.length, 2);
  assertEquals(result.content[1], { type: "text", text: note! });
});

Deno.test("deleted: no note without a recorded delete, nor on another key", async () => {
  const store = new FakeCardActivityStore();
  await recordCardActivity(store, S, deleted({ action: "saved", fields: ["subject"] }));
  await recordCardActivity(store, { ...S, apiKeyId: "key-2" }, deleted({ lineId: "line-2", draftId: "x:2" }));
  assertEquals(await peekCardDeletedNote(store, S, { lineId: "line-1", draftIds: [] }, { nowMs: NOW }), null);
  assertEquals(await peekCardDeletedNote(store, S, { lineId: "line-2", draftIds: ["x:2"] }, { nowMs: NOW }), null);
});

Deno.test("deleted: which failed calls are told", () => {
  const o = { approvalDispatch: false };
  for (const name of ["draft_read", "draft_update", "draft_send", "draft_delete"]) {
    assertEquals(goneNoteTargetDraftId(name, { draft_id: "D:1" }, o), "D:1", name);
  }
  assertEquals(goneNoteTargetDraftId("draft_send", { draft_id: "D:1", base_revision: 2 }, o), null, "the card's own call");
  assertEquals(goneNoteTargetDraftId("draft_list", { draft_id: "D:1" }, o), null);
  assertEquals(goneNoteTargetDraftId("draft_read", { draft_id: "D:1" }, { approvalDispatch: true }), null);
  // A success is never changed.
  const ok = { content: [{ type: "text", text: "{}" }] };
  appendNoteToErrorResult(ok, "x");
  assertEquals(ok.content.length, 1);
});

Deno.test("deleted: executeDeleteDraft records the card's Discard (base_revision) only", () => {
  const body = fnBody("executeDeleteDraft");
  assertStringIncludes(body, 'const baseRevision = parseBaseRevision(args["base_revision"]);');
  assertStringIncludes(body, 'action: "deleted",');
  assertStringIncludes(body, "baseRevision !== null && apiKey.internalApprovalDispatch !== true");
  assertStringIncludes(index, "if (note) appendNoteToErrorResult(outcome.result, note);");
});

Deno.test("deleted: the database accepts the new action", async () => {
  const dir = new URL("../../migrations/", import.meta.url);
  const sql = await Deno.readTextFile(new URL("20261026210000_draft_card_activity_deleted.sql", dir));
  assertStringIncludes(sql, "CHECK (action IN ('saved', 'sent', 'deleted'))");
  const selfHost = await Deno.readTextFile(new URL("../../../self-host/db/00-schema.sql", import.meta.url));
  assertStringIncludes(selfHost, "ARRAY['saved'::text, 'sent'::text, 'deleted'::text]");
});

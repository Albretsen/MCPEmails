// ---------------------------------------------------------------------------
// What was saved or sent through the draft editor reaches the model through
// the server (QA 2026-10-15). card-activity.ts, its wiring in
// mcp-app-drafts.ts and index.ts, and the receipt wording from the same QA run.
//
// The QA report these pin: after a save in the card Claude still reported the
// old subject and recipients; after a send from the card Claude said "No, I
// never sent it"; the receipt said "Delivered" for a message that went to
// spam, and named "IMAP + SMTP" twice.
//
// Round 2 (verifier, 2026-10-15): notes are claimed only on the MCP path and
// never for the web client; they belong to the API key whose editor call made
// them; and nothing claims a PERSON acted, because no signal on a request
// tells the card's call from a model's.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  alreadySentText,
  CARD_ACTIVITY_RETENTION_MS,
  type CardActivityEvent,
  cardActivityNote,
  closedBySendText,
  FakeCardActivityStore,
  noteCarrier,
  postgrestCardActivityStore,
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

const S = { workspaceId: "ws-1", inboxId: "inbox-1", apiKeyId: "key-1" };
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

const sent = (over: Partial<CardActivityEvent> = {}) =>
  saved({ action: "sent", fields: [], toCount: null, ccCount: null, bccCount: null, ...over });

// ── The note ────────────────────────────────────────────────────────────────

Deno.test("the note states a save and a send, oldest first, with no content and no claim of who", () => {
  const note = cardActivityNote([
    sent({ draftId: "Drafts:8", occurredAt: "2026-10-15T11:59:30Z" }),
    saved(),
  ]);
  assertEquals(
    note,
    "Since the last draft result for this inbox, the MCP Emails draft editor (the card in which the " +
      "user can edit, save and send a draft) recorded these changes, which may not appear in this " +
      "conversation. " +
      "At 2026-10-15T11:58:00Z draft Drafts:7 was saved, changing the subject and To. " +
      "Its recipients are now to 2, cc 0, bcc 0. " +
      "At 2026-10-15T11:59:30Z draft Drafts:8 was sent. " +
      "It is no longer a draft and that draft_id no longer resolves. " +
      "draft_read returns a saved draft's current subject, recipients and text.",
  );
  // base_revision is in the model-visible schema and app-only visibility is a
  // host hint, so the server cannot know a person did this.
  assert(!/the user (saved|sent)|by the user|from the card/.test(note!), note!);
});

Deno.test("a send alone does not point at draft_read, and nothing is a note of nothing", () => {
  const note = cardActivityNote([sent()])!;
  assert(!note.includes("draft_read"), note);
  assert(note.includes("draft Drafts:7 was sent."), note);
  assertEquals(cardActivityNote([]), null);
});

Deno.test("a long burst lists the newest five and counts the rest", () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    saved({ draftId: `Drafts:${i}`, occurredAt: new Date(NOW - (7 - i) * 1000).toISOString() })
  );
  const note = cardActivityNote(rows)!;
  assert(!note.includes("Drafts:0 ") && !note.includes("Drafts:1 "), note);
  assert(note.includes("Drafts:6"), note);
  assert(note.includes("2 earlier changes are not listed."), note);
});

// ── Said once, to the key that acted ─────────────────────────────────────────

Deno.test("each action is told once, only to the key and inbox it happened on, and only while recent", async () => {
  const store = new FakeCardActivityStore();
  await recordCardActivity(store, S, saved({ occurredAt: new Date(NOW - 60_000).toISOString() }), quiet);
  await recordCardActivity(store, { ...S, inboxId: "inbox-2" }, saved({ draftId: "Drafts:99" }), quiet);
  await recordCardActivity(store, S, saved({ draftId: "old", occurredAt: new Date(NOW - 25 * 3600_000).toISOString() }), quiet);

  // Another client (ChatGPT on key B, say) touching the same inbox first.
  assertEquals(await takeCardActivityNote(store, { ...S, apiKeyId: "key-2" }, NOW, quiet), null, "another key gets nothing");

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
  assertEquals(logged, ["draft_card_activity_record_failed", "draft_card_activity_claim_failed"]);
  assertEquals(await takeCardActivityNote(null, S, NOW), null);
});

// ── The real PostgREST query construction ───────────────────────────────────

/** A supabase-js-shaped client that records every call on every builder. */
function recordingClient(answer: { data?: unknown; error?: { message: string } | null } = {}) {
  const calls: Array<{ table: string; chain: Array<[string, unknown[]]> }> = [];
  const client = {
    from(table: string) {
      const entry = { table, chain: [] as Array<[string, unknown[]]> };
      calls.push(entry);
      const builder: Record<string, unknown> = {};
      for (const m of ["insert", "update", "delete", "select", "eq", "is", "gte", "lt"]) {
        builder[m] = (...args: unknown[]) => {
          entry.chain.push([m, args]);
          return builder;
        };
      }
      builder.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: answer.data ?? [], error: answer.error ?? null });
      return builder;
    },
  };
  return { client, calls };
}

Deno.test("the store's claim filters on workspace, inbox AND key, marks and returns in one statement", async () => {
  const { client, calls } = recordingClient({
    data: [{ id: "r1", draft_id: "Drafts:7", line_id: null, action: "saved", occurred_at: "2026-10-15T11:58:00Z", revision: 2, fields: ["to"], to_count: 1, cc_count: 0, bcc_count: 0 }],
  });
  const store = postgrestCardActivityStore(client, () => NOW);
  const rows = await store.claim(S, "2026-10-14T12:00:00Z", "2026-10-15T12:00:00Z");
  assertEquals(rows.map((r) => [r.draftId, r.fields, r.toCount]), [["Drafts:7", ["to"], 1]]);
  assertEquals(calls.length, 1, "one statement");
  const chain = calls[0].chain;
  assertEquals(calls[0].table, "draft_card_activity");
  assertEquals(chain[0], ["update", [{ reported_at: "2026-10-15T12:00:00Z" }]]);
  const filters = chain.filter(([m]) => m === "eq").map(([, a]) => a);
  assertEquals(filters, [["workspace_id", "ws-1"], ["inbox_id", "inbox-1"], ["api_key_id", "key-1"]]);
  assert(chain.some(([m, a]) => m === "is" && a[0] === "reported_at" && a[1] === null), "unreported only");
  assert(chain.some(([m, a]) => m === "gte" && a[0] === "occurred_at"), "recent only");
  assertEquals(chain.at(-1)?.[0], "select", "returns what it marked");
});

Deno.test("the store's insert carries the key, and retention deletes expired rows in every workspace", async () => {
  const { client, calls } = recordingClient();
  const store = postgrestCardActivityStore(client, () => NOW);
  await store.insert(S, saved());
  assertEquals(calls.length, 2);
  const [insert, cleanup] = calls;
  const row = insert.chain[0][1][0] as Record<string, unknown>;
  assertEquals([row.workspace_id, row.inbox_id, row.api_key_id], ["ws-1", "inbox-1", "key-1"]);
  assert(!("subject" in row) && !("to" in row), "no content");
  assertEquals(cleanup.chain[0][0], "delete");
  assertEquals(
    cleanup.chain.slice(1),
    [["lt", ["occurred_at", new Date(NOW - CARD_ACTIVITY_RETENTION_MS).toISOString()]]],
    "not filtered to one inbox: a quiet inbox's rows expire too",
  );
});

Deno.test("a PostgREST error from the store is caught by the callers", async () => {
  const { client } = recordingClient({ error: { message: 'relation "draft_card_activity" does not exist' } });
  const store = postgrestCardActivityStore(client, () => NOW);
  const logged: string[] = [];
  await recordCardActivity(store, S, saved(), (e) => logged.push(e));
  assertEquals(await takeCardActivityNote(store, S, NOW, (e) => logged.push(e)), null);
  assertEquals(logged, ["draft_card_activity_record_failed", "draft_card_activity_claim_failed"]);
});

// ── Which results carry it ────────────────────────────────────────────────

Deno.test("only a model's own draft calls carry the note, never a call the card makes", () => {
  const model = { approvalDispatch: false };
  for (const name of ["draft_list", "draft_create", "draft_reply", "draft_update"]) {
    assertEquals(noteCarrier(name, {}, model), true, name);
  }
  assertEquals(noteCarrier("draft_send", { draft_id: "d" }, model), true, "the model's send");
  assertEquals(noteCarrier("draft_send", { draft_id: "d", base_revision: 3 }, model), false, "the card's send");
  assertEquals(noteCarrier("draft_send", { draft_id: "d", base_revision: 0 }, model), false, "a card send at 0");
  for (const name of ["draft_read", "draft_editor_save", "draft_editor_hide", "draft_delete", "approval_decide", "email_search"]) {
    assertEquals(noteCarrier(name, {}, model), false, name);
  }
  assertEquals(noteCarrier("draft_list", {}, { approvalDispatch: true }), false, "an approved re-run");
});

// ── "Already sent" says when, never who ─────────────────────────────────────

Deno.test("the already-sent refusal says when, from the lineage, and never who", () => {
  assertEquals(
    alreadySentText({ requestedId: "Drafts:7", sentCopyKept: false, closedAt: "2026-10-15T11:59:31.500Z" }),
    "draft_send: draft Drafts:7 was already sent at 2026-10-15T11:59:31Z. Nothing was sent again.",
  );
  assertEquals(
    alreadySentText({ requestedId: "Drafts:7", sentCopyKept: true, closedAt: "2026-10-15T11:59:31Z" }),
    "draft_send: draft Drafts:7 was already sent at 2026-10-15T11:59:31Z, and its copy is still in the " +
      "Drafts folder. Nothing was sent again.",
  );
  assertEquals(
    alreadySentText({ requestedId: "Drafts:7", sentCopyKept: false, closedAt: null }),
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
  const lineScope = (i: DraftEditorProviderInbox) => ({ workspaceId: CALLER.workspace_id, inboxId: i.id });
  const scope = (i: DraftEditorProviderInbox) => ({ ...lineScope(i), apiKeyId: CALLER.id });
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
      resolve: (i, id) => resolveDraftId(store, lineScope(i), id, quiet),
      recordWrite: (i, previous, id, writtenBy, at) =>
        recordDraftWrite(store, lineScope(i), { previous, draftId: id, writtenBy, at }, quiet),
    },
    cardActivity: {
      record: (i, event) => recordCardActivity(activity, scope(i), event, quiet),
    },
    now: () => (clock += 1000),
  };
  const create = async () => {
    const id = `Drafts:${nextUid++}`;
    drafts.set(id, { subject: "Old subject", to: ["a@x.com"], cc: [], bcc: [], bodyText: "Hi", bodyHtml: null, attachments: [] });
    await recordDraftWrite(store, lineScope(INBOX), { previous: null, draftId: id, writtenBy: "agent", at: new Date(clock).toISOString() }, quiet);
    return id;
  };
  /** What executeSendDraft does after a send went out: close the line. */
  const sends = async (id: string, at: string) => {
    const line = await resolveDraftId(store, lineScope(INBOX), id, quiet);
    drafts.delete(line.draftId);
    await closeDraftLine(store, lineScope(INBOX), line, "sent", at, quiet);
  };
  return { deps, activity, create, sends };
}

const text = (out: DraftEditorToolResult) => out.result.content.map((c) => c.text).join(" ");

Deno.test("an editor save is recorded for its key, field names and counts only, and that key's next draft result says so", async () => {
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
  assertEquals(row.apiKeyId, "key-1", "the key the editor call came in on");
  assert(!JSON.stringify(row).includes("Secret"), "no subject is stored");
  assert(!JSON.stringify(row).includes("b@x.com"), "no address is stored");

  assertEquals(await takeCardActivityNote(m.activity, { ...S, apiKeyId: "key-2" }, NOW + 60_000, quiet), null);
  const note = await takeCardActivityNote(m.activity, S, NOW + 60_000, quiet);
  assert(note?.includes(`draft ${row.draftId} was saved, changing the subject and To.`), String(note));
});

Deno.test("a save that changes nothing records nothing", async () => {
  const m = mailbox();
  const id = await m.create();
  await runDraftEditorSave(m.deps, CALLER, { draft_id: id, subject: "Old subject" });
  assertEquals(m.activity.rows.length, 0);
});

Deno.test("draft_read of a sent draft says it was sent and when, not that it could not be found", async () => {
  const m = mailbox();
  const id = await m.create();
  await m.sends(id, "2026-10-15T12:05:00Z");
  const out = await runDraftRead(m.deps, CALLER, { draft_id: id });
  assertEquals(out.result.isError, true);
  assertEquals(text(out), closedBySendText({ draftId: id, closedAt: "2026-10-15T12:05:00Z" }));
  assertEquals(
    text(out),
    `Draft ${id} was already sent at 2026-10-15T12:05:00Z. It is no longer a draft, so this draft_id ` +
      "no longer resolves. Nothing was changed.",
  );
  // The card's receipt is unchanged: same code, same person's words.
  const receipt = (out.result.structuredContent as Record<string, any>).receipt;
  assertEquals([receipt.error_code, receipt.headline], ["draft_not_found", "This draft was already sent."]);
});

// ── index.ts wiring (it cannot be imported: it serves at module load) ───────

Deno.test("index.ts claims the note on the MCP tools/call path only, scoped to the key, and records sends honestly", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

  // 1. Not in dispatchExecutor, which client-api also runs for the web client.
  const dispatch = src.slice(src.indexOf("async function dispatchExecutor("), src.indexOf("async function runExecutor("));
  assert(!dispatch.includes("takeCardActivityNote("), "dispatchExecutor must not claim notes");
  const call = src.slice(src.indexOf("async function handleToolsCall("));
  assert(call.includes("takeCardActivityNote("), "handleToolsCall claims");
  assert(call.includes("noteForResult(note)"), "and attaches with the other result notes");
  assertEquals(src.split("takeCardActivityNote(").length - 1, 1, "and nothing else claims");
  // And the web client never reaches handleToolsCall: client-api's runtime
  // code calls the executors through dispatchExecutor only.
  const clientApi = new URL("../client-api/", import.meta.url);
  const offenders: string[] = [];
  const walk = async (dir: URL) => {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory && e.name !== "tests") await walk(new URL(`${e.name}/`, dir));
      else if (e.isFile && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        const code = (await Deno.readTextFile(new URL(e.name, dir)))
          .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
        if (/handleToolsCall\s*\(/.test(code)) offenders.push(e.name);
      }
    }
  };
  await walk(clientApi);
  assertEquals(offenders, [], "client-api never runs the MCP tools/call path");

  // 2. The scope carries the key.
  assert(
    src.includes("return { workspaceId: apiKey.workspace_id, inboxId, apiKeyId: apiKey.id };"),
    "card activity is scoped to the API key",
  );
  assert(src.includes("postgrestCardActivityStore(supabase)"), "through the tested store");

  // 3. A send on the editor's path is recorded, but not for an approved re-run
  // or the web client, and the refusal no longer looks up who sent it.
  const send = src.slice(src.indexOf("async function executeSendDraft("), src.indexOf("async function executeDeleteDraft("));
  assert(
    /baseRevision !== null && apiKey\.internalApprovalDispatch !== true\s*\?\s*recordCardActivity\(/.test(send),
    "an editor-path send is recorded, an approved re-run is not",
  );
  assert(send.includes("alreadySentText({"), "the refusal says when");
  assert(!send.includes("cardSentAt"), "and never who");
  assert(send.includes("DRAFT_SENT_RECEIPT_DETAIL"), "the receipt detail is the shared constant");
  assert(!send.includes("`Delivered via"), "no more 'Delivered via'");

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

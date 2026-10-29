// ---------------------------------------------------------------------------
// The draft editor against a mailbox that behaves like IMAP: every save
// removes the old message and stores a new one under a new id.
//
// QA 2026-10-13, the three reports these pin:
//   * a save came back as a transport error although it had been stored, and
//     the retry hit draft_not_found;
//   * a reloaded card held the id of its first tool result and Refresh
//     dead-ended on it while the draft sat in the mailbox under a newer id;
//   * editing the body flattened the rich signature, and Refresh rewrote the
//     header to "saved by the assistant" when the last save was the person's.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type DraftEditorCaller,
  type DraftEditorDeps,
  type DraftEditorProviderInbox,
  type DraftEditorToolResult,
  type ProviderDraft,
  runDraftEditorSave,
  runDraftRead,
} from "./mcp-app-drafts.ts";
import { closeDraftLine, recordDraftWrite, resolveDraftId } from "./draft-lineage.ts";
import { memoryLineageStore } from "./draft-lineage-fake.ts";
import { applySignature } from "./signature-compose.ts";

const RICH_SIGNATURE_HTML =
  '<table><tr><td><img src="https://mcpemails.com/logo.png" alt="MCPEmails"></td>' +
  '<td><b>Asgeir Albretsen</b><br><a href="https://mcpemails.com">mcpemails.com</a></td></tr></table>';

const INBOX: DraftEditorProviderInbox = {
  id: "inbox-1",
  email_address: "you@example.com",
  display_name: "Asgeir",
  provider: "imap",
  service: null,
  signature_enabled: true,
  signature_text: "Asgeir Albretsen\nmcpemails.com",
  signature_html: RICH_SIGNATURE_HTML,
};

const CALLER: DraftEditorCaller = {
  id: "key-1",
  workspace_id: "ws-1",
  scopes: ["manage:drafts", "read:email", "send:email"],
  inbox_ids: null,
  user_id: "user-1",
};

/** A draft as `draft{action:"create"}` stores it: signed, with a rich HTML part. */
function signedDraft(body: string): ProviderDraft {
  const signed = applySignature({ textBody: body } as { textBody: string; htmlBody?: string }, INBOX);
  return {
    subject: "Quarterly numbers",
    to: ["a@x.com"],
    cc: [],
    bcc: [],
    bodyText: signed.textBody,
    bodyHtml: signed.htmlBody ?? null,
    attachments: [],
  };
}

function mailbox(
  options: { inbox?: DraftEditorProviderInbox; lineageFails?: boolean; stableIds?: boolean } = {},
) {
  const inbox = options.inbox ?? INBOX;
  const drafts = new Map<string, ProviderDraft>();
  const { store, rows } = memoryLineageStore({ failing: options.lineageFails });
  const scope = (i: DraftEditorProviderInbox) => ({ workspaceId: CALLER.workspace_id, inboxId: i.id });
  const quiet = () => {};
  let nextUid = 1;
  let clock = Date.parse("2026-10-13T12:00:00Z");
  const writes: string[] = [];
  const deps: DraftEditorDeps = {
    appUrl: "https://mcpemails.com",
    workspaceGate: () => Promise.resolve({ rolledOut: true, hidden: false }),
    inboxHidden: () => Promise.resolve(false),
    workspaceRole: () => Promise.resolve("owner"),
    resolveInbox: () => Promise.resolve({ ok: true as const, inbox }),
    getDraft: (_inbox, id) => Promise.resolve(drafts.get(id) ?? null),
    updateDraft: (_inbox, id, params) => {
      // imapUpdateDraft: refuse an id that is gone, else append + expunge.
      // `stableIds`: Gmail and Outlook, which rewrite in place.
      if (!drafts.has(id)) return Promise.reject(new Error("draft_not_found"));
      drafts.delete(id);
      const newId = options.stableIds ? id : `Drafts:${nextUid++}`;
      drafts.set(newId, {
        subject: params.subject,
        to: params.to,
        cc: params.cc,
        bcc: params.bcc,
        bodyText: params.body,
        bodyHtml: params.htmlBody ?? null,
        attachments: [],
      });
      writes.push(newId);
      return Promise.resolve({ draft_id: newId });
    },
    isValidEmailAddress: (address: string) => /^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(address),
    setDraftEditorHidden: () => Promise.resolve(),
    lineage: {
      resolve: (i, id) => resolveDraftId(store, scope(i), id, quiet),
      recordWrite: (i, previous, id, writtenBy, at) =>
        recordDraftWrite(store, scope(i), { previous, draftId: id, writtenBy, at }, quiet),
    },
    now: () => (clock += 1000),
  };
  /** What `draft{action:"create"}` does: store it and open its line. */
  const agentCreates = async (draft: ProviderDraft) => {
    const id = `Drafts:${nextUid++}`;
    drafts.set(id, draft);
    await recordDraftWrite(store, scope(inbox), {
      previous: null,
      draftId: id,
      writtenBy: "agent",
      at: new Date(clock).toISOString(),
    }, quiet);
    return id;
  };
  /** A send or a delete. `sent_kept`: sent, and the draft copy stayed in Drafts. */
  const close = async (id: string, how: "sent" | "sent_kept" | "deleted") => {
    const line = await resolveDraftId(store, scope(inbox), id, quiet);
    if (how !== "sent_kept") drafts.delete(line.draftId);
    await closeDraftLine(store, scope(inbox), line, how, undefined, quiet);
  };
  const newId = () => options.stableIds ? `r-${nextUid++}` : `Drafts:${nextUid++}`;
  return { deps, drafts, rows, writes, agentCreates, close, newId, stable: options.stableIds === true };
}

const draftOf = (out: DraftEditorToolResult) =>
  (out.result.structuredContent as Record<string, any>).draft;
const receiptOf = (out: DraftEditorToolResult) =>
  (out.result.structuredContent as Record<string, any>).receipt;

// ── Lineage ─────────────────────────────────────────────────────────────────

Deno.test("a card holding a stale id reads the current draft", async () => {
  const m = mailbox();
  const first = await m.agentCreates(signedDraft("Here they are."));
  const saved = await runDraftEditorSave(m.deps, CALLER, { draft_id: first, subject: "Q3 numbers" });
  const current = draftOf(saved).draft_id;
  assert(current !== first, "IMAP moved the id");

  // The reloaded card: it still has the id of its first tool result.
  const read = await runDraftRead(m.deps, CALLER, { draft_id: first });
  assertEquals(read.result.isError, false);
  assertEquals(draftOf(read).draft_id, current, "the envelope returns the id to adopt");
  assertEquals(draftOf(read).resolved_from, first, "and says which id it was asked for");
  assertEquals(draftOf(read).subject, "Q3 numbers");

  // Asked with the current id there is nothing to report.
  const direct = await runDraftRead(m.deps, CALLER, { draft_id: current });
  assert(!("resolved_from" in draftOf(direct)));
});

Deno.test("a save after a lost response: the card re-reads first, then saves on the current id", async () => {
  const m = mailbox();
  const first = await m.agentCreates(signedDraft("Here they are."));
  const patch = { draft_id: first, subject: "Q3 numbers", cc: ["hello@mcpemails.com"] };

  // The first attempt is stored; its response never reaches the card.
  const lost = await runDraftEditorSave(m.deps, CALLER, patch);
  const afterFirst = draftOf(lost).draft_id;

  // Retried blind with the OLD id, it is refused and writes nothing.
  const blind = await runDraftEditorSave(m.deps, CALLER, patch);
  assertEquals(receiptOf(blind).error_code, "draft_changed");
  assertEquals(m.writes.length, 1, "no second write");

  // What the card does instead: re-read (which follows the line), adopt.
  const read = draftOf(await runDraftRead(m.deps, CALLER, { draft_id: first }));
  assertEquals(read.draft_id, afterFirst);
  assertEquals(read.recipients.cc, ["hello@mcpemails.com"], "the lost save had landed");
  assertEquals(read.revision, draftOf(lost).revision, "the same revision the lost answer carried");

  // And the next save, on the adopted id and revision, goes through.
  const next = await runDraftEditorSave(m.deps, CALLER, {
    draft_id: read.draft_id,
    base_revision: read.revision,
    subject: "Q3 numbers, final",
  });
  assertEquals(next.result.isError, false);
  assertEquals(m.drafts.size, 1, "still one draft");
  assertEquals(m.drafts.get(draftOf(next).draft_id)!.subject, "Q3 numbers, final");
  assertEquals(draftOf(next).revision, read.revision + 1);
});

// ── A stale card never writes over a newer revision (review, 2026-10-13) ────

/** What `draft{action:"update"}` does on IMAP: a new id, recorded as the agent's. */
async function agentUpdates(
  m: ReturnType<typeof mailbox>,
  id: string,
  change: Partial<ProviderDraft>,
): Promise<string> {
  const line = await m.deps.lineage!.resolve(INBOX, id);
  const cur = m.drafts.get(line.draftId)!;
  m.drafts.delete(line.draftId);
  const next = m.stable ? line.draftId : m.newId();
  m.drafts.set(next, { ...cur, ...change });
  await m.deps.lineage!.recordWrite(INBOX, line, next, "agent", new Date().toISOString());
  return next;
}

Deno.test("two cards: the stale one's Save is refused as draft_changed, and the newer revision stands", async () => {
  const m = mailbox();
  const x = await m.agentCreates(signedDraft("Original body."));
  // Card A mounts on the create result.
  const cardA = draftOf(await runDraftRead(m.deps, CALLER, { draft_id: x }));
  // The model updates the draft: card B shows the new revision under a new id.
  const y = await agentUpdates(m, x, {
    to: ["new-recipient@x.com"],
    bodyText: m.drafts.get(x)!.bodyText!.replace("Original body.", "Agent's corrected body."),
  });
  const before = structuredClone(m.drafts.get(y));

  // The person edits card A and presses Save.
  const out = await runDraftEditorSave(m.deps, CALLER, {
    draft_id: cardA.draft_id,
    base_revision: cardA.revision,
    body_text: cardA.body.text.replace("Original body.", "Original body!"),
  });
  assertEquals(out.result.isError, true);
  assertEquals(receiptOf(out).error_code, "draft_changed");
  assertEquals(receiptOf(out).headline, "This draft was changed somewhere else.");
  assertEquals(m.writes.length, 0, "nothing was written");
  assertEquals(m.drafts.get(y), before, "the model's revision is untouched");

  // No copy of the current draft rides along: the card re-reads it.
  assertEquals("current" in (out.result.structuredContent as Record<string, unknown>), false);
  const reread = draftOf(await runDraftRead(m.deps, CALLER, { draft_id: cardA.draft_id }));
  assertEquals([reread.draft_id, reread.resolved_from], [y, x]);
  assertEquals(reread.recipients.to, ["new-recipient@x.com"]);
  assertEquals(reread.revision, cardA.revision + 1);
  // The model's channel says what happened without the body.
  assert(!out.result.content[0].text.includes("corrected"));
});

Deno.test("ids that never move (Gmail, Outlook): a revision the draft has moved past is refused", async () => {
  const m = mailbox({ stableIds: true });
  const id = await m.agentCreates(signedDraft("Original body."));
  const cardA = draftOf(await runDraftRead(m.deps, CALLER, { draft_id: id }));
  assertEquals(cardA.revision, 1);
  // The model rewrites it in place: same id, next revision.
  const same = await agentUpdates(m, id, { subject: "Agent's subject" });
  assertEquals(same, id, "the id did not move");

  const out = await runDraftEditorSave(m.deps, CALLER, {
    draft_id: id,
    base_revision: cardA.revision,
    subject: "Person's subject",
  });
  assertEquals(receiptOf(out).error_code, "draft_changed");
  assertEquals(m.drafts.get(id)!.subject, "Agent's subject");
  assertEquals(draftOf(await runDraftRead(m.deps, CALLER, { draft_id: id })).revision, 2);

  // Saving against the revision it has now goes through, and moves it on.
  const ok = await runDraftEditorSave(m.deps, CALLER, { draft_id: id, base_revision: 2, subject: "Person's subject" });
  assertEquals(ok.result.isError, false);
  assertEquals(draftOf(ok).revision, 3);
  assertEquals(draftOf(ok).last_saved_by, "user");
});

Deno.test("review 2: a model write recorded while the card's save reads the draft is caught by the late check", async () => {
  const m = mailbox({ stableIds: true });
  const id = await m.agentCreates(signedDraft("Original body."));
  const card = draftOf(await runDraftRead(m.deps, CALLER, { draft_id: id }));
  // The model's update lands (and is recorded) while the save is reading the
  // stored draft, i.e. after the save's first lineage check.
  const getDraft = m.deps.getDraft;
  let interleaved = false;
  m.deps.getDraft = async (inbox, draftId) => {
    const out = await getDraft(inbox, draftId);
    if (!interleaved) {
      interleaved = true;
      await agentUpdates(m, id, { subject: "Agent's subject" });
    }
    return out;
  };
  const out = await runDraftEditorSave(m.deps, CALLER, {
    draft_id: id,
    base_revision: card.revision,
    subject: "Person's subject",
  });
  assertEquals(receiptOf(out).error_code, "draft_changed");
  assertEquals(m.drafts.get(id)!.subject, "Agent's subject", "the card did not write over it");
});

Deno.test("review 2: a model write recorded during the card's provider write leaves the card no revision to send on", async () => {
  const m = mailbox({ stableIds: true });
  const id = await m.agentCreates(signedDraft("Original body."));
  const card = draftOf(await runDraftRead(m.deps, CALLER, { draft_id: id }));
  // The provider takes the card's write, then the model's; the model records
  // first. Nothing on the server can order the two provider writes.
  const updateDraft = m.deps.updateDraft;
  let interleaved = false;
  m.deps.updateDraft = async (inbox, draftId, params) => {
    const out = await updateDraft(inbox, draftId, params);
    if (!interleaved) {
      interleaved = true;
      await agentUpdates(m, id, { subject: "Agent's subject" });
    }
    return out;
  };
  const saved = await runDraftEditorSave(m.deps, CALLER, {
    draft_id: id,
    base_revision: card.revision,
    subject: "Person's subject",
  });
  assertEquals(saved.result.isError, false);
  const held = draftOf(saved).revision;
  // The line moved on twice (model, then the card's contended record); the
  // card is handed the revision it loaded, which the line is past.
  assertEquals(held, card.revision);
  const send = await runDraftEditorSave(m.deps, CALLER, { draft_id: id, base_revision: held, subject: "Again" });
  assertEquals(receiptOf(send).error_code, "draft_changed", "it re-reads before it writes again");
  const reread = draftOf(await runDraftRead(m.deps, CALLER, { draft_id: id }));
  assertEquals(reread.subject, "Agent's subject", "what the card re-reads is what the mailbox holds");
});

Deno.test("review 2: the draft_changed receipt carries no copy of the draft", async () => {
  const m = mailbox({ stableIds: true });
  const id = await m.agentCreates(signedDraft("Original body."));
  await agentUpdates(m, id, { subject: "Agent's subject" });
  const out = await runDraftEditorSave(m.deps, CALLER, { draft_id: id, base_revision: 1, subject: "x" });
  assertEquals(receiptOf(out).error_code, "draft_changed");
  assertEquals(Object.keys(out.result.structuredContent as Record<string, unknown>).includes("current"), false);
  assert(!JSON.stringify(out.result).includes("Agent's subject"));
});

Deno.test("a card's own saves in a row each carry the revision the next one needs", async () => {
  const m = mailbox();
  let d = draftOf(await runDraftRead(m.deps, CALLER, { draft_id: await m.agentCreates(signedDraft("One.")) }));
  for (const subject of ["a", "b", "c"]) {
    const out = await runDraftEditorSave(m.deps, CALLER, { draft_id: d.draft_id, base_revision: d.revision, subject });
    assertEquals(out.result.isError, false, subject);
    d = draftOf(out);
  }
  assertEquals(d.revision, 4);
  assertEquals(m.writes.length, 3);
});

Deno.test("a draft no line names: base_revision 0 saves; once a line exists, 0 is stale", async () => {
  const m = mailbox({ stableIds: true });
  m.drafts.set("r-50", signedDraft("Written in a mail app."));
  const read = draftOf(await runDraftRead(m.deps, CALLER, { draft_id: "r-50" }));
  assert(!("revision" in read), "no revision to publish");
  const first = await runDraftEditorSave(m.deps, CALLER, { draft_id: "r-50", base_revision: 0, subject: "Mine" });
  assertEquals(first.result.isError, false);
  assertEquals(draftOf(first).revision, 1);
  // Another card still holding the pre-line copy.
  const stale = await runDraftEditorSave(m.deps, CALLER, { draft_id: "r-50", base_revision: 0, subject: "Theirs" });
  assertEquals(receiptOf(stale).error_code, "draft_changed");
  assertEquals(m.drafts.get("r-50")!.subject, "Mine");
});

Deno.test("lineage that cannot be read never refuses a save on revision", async () => {
  const m = mailbox({ lineageFails: true, stableIds: true });
  m.drafts.set("r-50", signedDraft("Here they are."));
  const out = await runDraftEditorSave(m.deps, CALLER, { draft_id: "r-50", base_revision: 7, subject: "Q3" });
  assertEquals(out.result.isError, false);
  assert(!("revision" in draftOf(out)), "and claims no revision it could not record");
});

Deno.test("an invalid base_revision is refused before anything is read", async () => {
  const m = mailbox();
  const first = await m.agentCreates(signedDraft("Here they are."));
  for (const base_revision of [-1, 1.5, "2", true]) {
    const out = await runDraftEditorSave(m.deps, CALLER, { draft_id: first, base_revision, subject: "s" });
    assertEquals(receiptOf(out).error_code, "invalid_arguments", String(base_revision));
  }
  assertEquals(m.writes.length, 0);
});

// ── An id the mailbox has given to another message (review finding 5) ──────

Deno.test("an older id that names a message again is that message, never the line's head", async () => {
  const m = mailbox();
  const x = await m.agentCreates(signedDraft("Original body."));
  const y = await agentUpdates(m, x, { subject: "The line's head" });
  // UIDVALIDITY reset (or a mail client): `x` is a different draft now.
  m.drafts.set(x, { ...signedDraft("A different draft."), subject: "Reused id" });

  const read = draftOf(await runDraftRead(m.deps, CALLER, { draft_id: x }));
  assertEquals([read.draft_id, read.subject], [x, "Reused id"]);
  assert(!("resolved_from" in read) && !("revision" in read));

  const saved = await runDraftEditorSave(m.deps, CALLER, { draft_id: x, base_revision: 0, subject: "Reused, edited" });
  assertEquals(saved.result.isError, false);
  assertEquals(m.drafts.get(y)!.subject, "The line's head", "the other draft is untouched");
  assertEquals(m.drafts.get(draftOf(saved).draft_id)!.subject, "Reused, edited");
});

Deno.test("a sent draft's id that names a new draft is not 'already sent'; a copy left by the send is", async () => {
  // The send removed its draft, and the id later names another one.
  const m = mailbox();
  const x = await m.agentCreates(signedDraft("Sent one."));
  await m.close(x, "sent");
  m.drafts.set(x, { ...signedDraft("A new draft."), subject: "New" });
  const read = await runDraftRead(m.deps, CALLER, { draft_id: x });
  assertEquals(read.result.isError, false);
  assertEquals(draftOf(read).subject, "New");

  // The send could NOT remove its draft: the copy there is what was sent.
  const k = mailbox();
  const id = await k.agentCreates(signedDraft("Sent one."));
  await k.close(id, "sent_kept");
  assert(k.drafts.has(id), "the copy is still in Drafts");
  for (const run of [runDraftRead, runDraftEditorSave]) {
    const out = await run(k.deps, CALLER, { draft_id: id, subject: "again" });
    assertEquals(receiptOf(out).headline, "This draft was already sent.");
  }
  assertEquals(k.writes.length, 0);
});

Deno.test("another inbox cannot resolve this inbox's ids", async () => {
  const m = mailbox();
  const first = await m.agentCreates(signedDraft("Here they are."));
  await runDraftEditorSave(m.deps, CALLER, { draft_id: first, subject: "Q3 numbers" });

  // Same lineage rows, a call that resolved to a different inbox.
  const other = mailbox({ inbox: { ...INBOX, id: "inbox-2" } });
  other.deps.lineage = m.deps.lineage;
  const read = await runDraftRead(other.deps, CALLER, { draft_id: first });
  assertEquals(read.result.isError, true);
  assertEquals(receiptOf(read).error_code, "draft_not_found");
});

Deno.test("a draft that was sent or discarded says so, in words", async () => {
  for (const [how, headline] of [
    ["sent", "This draft was already sent."],
    ["deleted", "This draft was discarded."],
  ] as const) {
    const m = mailbox();
    const first = await m.agentCreates(signedDraft("Here they are."));
    const saved = await runDraftEditorSave(m.deps, CALLER, { draft_id: first, subject: "Q3" });
    await m.close(draftOf(saved).draft_id, how);

    for (const run of [runDraftRead, runDraftEditorSave]) {
      const out = await run(m.deps, CALLER, { draft_id: first, subject: "again" });
      assertEquals(out.result.isError, true);
      assertEquals(receiptOf(out).error_code, "draft_not_found", "the machine code is unchanged");
      assertEquals(receiptOf(out).headline, headline);
    }
    assertEquals(m.writes.length, 1, "nothing written after the line closed");
  }
});

Deno.test("lineage that cannot be read or written never fails the action", async () => {
  const m = mailbox({ lineageFails: true });
  m.drafts.set("Drafts:50", signedDraft("Here they are."));
  const read = await runDraftRead(m.deps, CALLER, { draft_id: "Drafts:50" });
  assertEquals(read.result.isError, false);
  const saved = await runDraftEditorSave(m.deps, CALLER, { draft_id: "Drafts:50", subject: "Q3" });
  assertEquals(saved.result.isError, false);
  assertEquals(m.drafts.get(draftOf(saved).draft_id)!.subject, "Q3");
  // And the stale id then behaves as it did before lineage existed.
  const stale = await runDraftRead(m.deps, CALLER, { draft_id: "Drafts:50" });
  assertEquals(receiptOf(stale).error_code, "draft_not_found");
});

Deno.test("no lineage port at all is the pre-lineage behaviour", async () => {
  const m = mailbox();
  delete m.deps.lineage;
  m.drafts.set("Drafts:50", signedDraft("Here they are."));
  const saved = await runDraftEditorSave(m.deps, CALLER, { draft_id: "Drafts:50", subject: "Q3" });
  assertEquals(saved.result.isError, false);
  assertEquals(receiptOf(await runDraftRead(m.deps, CALLER, { draft_id: "Drafts:50" })).error_code, "draft_not_found");
});

// ── Who saved last ──────────────────────────────────────────────────────────

Deno.test("a read does not claim a save happened, or change who saved last", async () => {
  const m = mailbox();
  const first = await m.agentCreates(signedDraft("Here they are."));

  // Straight after the assistant wrote it.
  const fresh = draftOf(await runDraftRead(m.deps, CALLER, { draft_id: first }));
  assertEquals(fresh.origin, "read");
  assertEquals(fresh.last_saved_by, "agent");

  const saved = draftOf(await runDraftEditorSave(m.deps, CALLER, { draft_id: first, subject: "Q3" }));
  assertEquals(saved.last_saved_by, "user");

  // Refresh, twice. The header must keep saying what the save said.
  const one = draftOf(await runDraftRead(m.deps, CALLER, { draft_id: saved.draft_id }));
  const two = draftOf(await runDraftRead(m.deps, CALLER, { draft_id: saved.draft_id }));
  for (const read of [one, two]) {
    assertEquals(read.last_saved_by, "user", "the last save was the person's");
    assertEquals(read.last_saved_at, saved.last_saved_at, "and it happened when it happened");
  }
});

Deno.test("a draft nobody recorded names no writer and invents no save time", async () => {
  const m = mailbox();
  m.drafts.set("Drafts:50", signedDraft("Written in a mail app."));
  const read = draftOf(await runDraftRead(m.deps, CALLER, { draft_id: "Drafts:50" }));
  assertEquals(read.last_saved_by, null);
  assertEquals(read.last_saved_at, null);

  // With the mailbox's own timestamp, that is the time shown.
  m.drafts.set("Drafts:51", { ...signedDraft("x"), savedAt: "Tue, 13 Oct 2026 09:30:00 +0200" });
  const dated = draftOf(await runDraftRead(m.deps, CALLER, { draft_id: "Drafts:51" }));
  assertEquals(dated.last_saved_at, "2026-10-13T07:30:00.000Z");
  assertEquals(dated.last_saved_by, null);
});

// ── The rich signature ──────────────────────────────────────────────────────

Deno.test("editing the body keeps the inbox's rich signature in the HTML part", async () => {
  const m = mailbox();
  const stored = signedDraft("Here they are.");
  const first = await m.agentCreates(stored);
  assertEquals(draftOf(await runDraftRead(m.deps, CALLER, { draft_id: first })).signature, {
    embedded: true,
    rich: true,
  });

  // What a textarea sends back: CRLF, the signature untouched.
  const edited = stored.bodyText!.replace("Here they are.", "Here they are, with a <fix> & more.")
    .replace(/\n/g, "\r\n");
  const out = await runDraftEditorSave(m.deps, CALLER, { draft_id: first, body_text: edited });
  const draft = draftOf(out);
  const html: string = draft.body.html;

  assert(html.includes(RICH_SIGNATURE_HTML), "logo, link and table survive");
  assert(html.includes("Here they are, with a &lt;fix&gt; &amp; more."), "the edit is there, escaped");
  assert(!html.includes("-- "), "the text delimiter never reaches the HTML");
  assertEquals(html.split('class="mcpemails-signature"').length, 2, "the signature appears once");
  // Byte for byte what create would have built for the new wording.
  assertEquals(
    html,
    applySignature({ textBody: "Here they are, with a <fix> & more." } as { textBody: string; htmlBody?: string }, INBOX).htmlBody,
  );
  assertEquals(draft.signature, { embedded: true, rich: true });
  assertEquals(draft.body.text, edited, "the text part is written exactly as given");
});

Deno.test("a reply keeps its quoted original after the signature", async () => {
  const m = mailbox();
  const stored = signedDraft("Thanks.");
  stored.bodyText += "\n\nOn Tue, 13 Oct 2026, Anna wrote:\n> see <attached>";
  const first = await m.agentCreates(stored);
  const out = await runDraftEditorSave(m.deps, CALLER, {
    draft_id: first,
    body_text: stored.bodyText!.replace("Thanks.", "Thanks a lot."),
  });
  const html: string = draftOf(out).body.html;
  const sigAt = html.indexOf(RICH_SIGNATURE_HTML);
  assert(sigAt > html.indexOf("Thanks a lot."));
  assert(html.indexOf("&gt; see &lt;attached&gt;") > sigAt, "the quote follows the signature, escaped");
});

Deno.test("editing the signature text itself leaves no HTML part, and the envelope says so", async () => {
  const m = mailbox();
  const stored = signedDraft("Here they are.");
  const first = await m.agentCreates(stored);

  // QA: "adding two characters to the signature".
  const out = await runDraftEditorSave(m.deps, CALLER, {
    draft_id: first,
    body_text: `${stored.bodyText}xx`,
  });
  const draft = draftOf(out);
  assertEquals(out.result.isError, false);
  assertEquals(draft.body.html, null, "nothing formatted is left, so no formatted view is offered");
  assertEquals(draft.body.formatting_removed, true, "and the card is told it was removed");
  // Still "embedded" (the words are in the text), no longer `rich`.
  assertEquals(draft.signature, { embedded: true });
  assertEquals(m.drafts.get(draft.draft_id)!.bodyHtml, null, "no HTML part was written");
  assertEquals(m.drafts.get(draft.draft_id)!.bodyText, `${stored.bodyText}xx`);
});

Deno.test("a signature restyled on the dashboard since the draft was written is kept as the draft had it", async () => {
  const m = mailbox();
  const stored = signedDraft("Here they are.");
  const first = await m.agentCreates(stored);
  // The person changes their signature on the dashboard after the draft exists.
  m.deps.resolveInbox = () =>
    Promise.resolve({
      ok: true as const,
      inbox: {
        ...INBOX,
        signature_text: "Asgeir A.\nCEO",
        signature_html: "<p><i>Asgeir A.</i><br>CEO</p>",
      },
    });
  const out = await runDraftEditorSave(m.deps, CALLER, {
    draft_id: first,
    body_text: stored.bodyText!.replace("Here they are.", "Here they are, again."),
  });
  const draft = draftOf(out);
  assert(draft.body.html.includes(RICH_SIGNATURE_HTML), "the draft's own logo, link and table");
  assert(!draft.body.html.includes("CEO"), "not today's dashboard signature");
  assert(!draft.body.html.includes("-- "));
  assert(!("formatting_removed" in draft.body));
  assertEquals(draft.signature, { embedded: true, rich: true });
});

Deno.test("clearing a signed body leaves no empty HTML part, and says the formatting went", async () => {
  const m = mailbox();
  const first = await m.agentCreates(signedDraft("Here they are."));
  const draft = draftOf(await runDraftEditorSave(m.deps, CALLER, { draft_id: first, body_text: "" }));
  assertEquals(draft.body.html, null);
  assertEquals(draft.body.formatting_removed, true);
  assertEquals(m.drafts.get(draft.draft_id)!.bodyHtml, null);
});

Deno.test("a recipients-and-subject save leaves the HTML part exactly as stored", async () => {
  const m = mailbox();
  const stored = signedDraft("Here they are.");
  const first = await m.agentCreates(stored);
  const out = await runDraftEditorSave(m.deps, CALLER, {
    draft_id: first,
    subject: "Q3",
    cc: ["hello@mcpemails.com"],
  });
  assertEquals(draftOf(out).body.html, stored.bodyHtml);
  assert(!("formatting_removed" in draftOf(out).body));
});

// ── Recipients ──────────────────────────────────────────────────────────────

Deno.test("a mistyped recipient is refused, never dropped", async () => {
  const m = mailbox();
  const first = await m.agentCreates(signedDraft("Here they are."));
  for (const to of [["a@b"], ["good@x.com", "a@b"], ["good@x.com", 7], ["good@x.com", " "]]) {
    const out = await runDraftEditorSave(m.deps, CALLER, { draft_id: first, to, subject: "Q3" });
    assertEquals(out.result.isError, true, JSON.stringify(to));
    assertEquals(receiptOf(out).error_code, "invalid_recipients");
  }
  assertEquals(m.writes.length, 0, "nothing was written, including the subject");
  assertEquals(m.drafts.get(first)!.to, ["a@x.com"]);
});

// ── Copy a person reads ─────────────────────────────────────────────────────

Deno.test("card receipts are written for a person; the model's text is unchanged", async () => {
  const m = mailbox();
  const missing = await runDraftRead(m.deps, CALLER, { draft_id: "Drafts:404" });
  const receipt = receiptOf(missing);
  for (const text of [receipt.headline, receipt.detail]) {
    assert(!/draft_not_found|draft id|draft list|IMAP|-32\d{3}|Error:/i.test(text), text);
    assert(!text.includes("—"), "no em dash");
  }
  assertEquals(receipt.error_code, "draft_not_found");
  // `content` is the model's channel and says what it always said.
  assertEquals(
    missing.result.content[0].text,
    "That draft could not be found. It may have been sent, discarded, or saved again under a new id. " +
      "On IMAP every save changes the draft id, so an id from before the last save no longer resolves. " +
      "Reload the draft list to get the current id.",
  );

  const noScope = await runDraftEditorSave(m.deps, { ...CALLER, scopes: [] }, { draft_id: "x", subject: "s" });
  assert(!receiptOf(noScope).detail.includes("manage:drafts"));
  assert(noScope.result.content[0].text.includes("'manage:drafts'"));

  const bad = await runDraftEditorSave(m.deps, CALLER, { draft_id: "x" });
  assert(!/to, cc, bcc|body_text/.test(receiptOf(bad).detail));
  assertEquals(receiptOf(bad).error_code, "invalid_arguments");
});

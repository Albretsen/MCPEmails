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
  '<table><tr><td><img src="https://mcpemails.com/logo.png" alt="MCP Emails"></td>' +
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

function mailbox(options: { inbox?: DraftEditorProviderInbox; lineageFails?: boolean } = {}) {
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
  const close = async (id: string, how: "sent" | "deleted") => {
    const line = await resolveDraftId(store, scope(inbox), id, quiet);
    drafts.delete(line.draftId);
    await closeDraftLine(store, scope(inbox), line, how, undefined, quiet);
  };
  return { deps, drafts, rows, writes, agentCreates, close };
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

Deno.test("a save retried after a lost response lands on the saved draft, once", async () => {
  const m = mailbox();
  const first = await m.agentCreates(signedDraft("Here they are."));
  const patch = { draft_id: first, subject: "Q3 numbers", cc: ["hello@mcpemails.com"] };

  // The first attempt is stored; its response never reaches the card.
  const lost = await runDraftEditorSave(m.deps, CALLER, patch);
  const afterFirst = draftOf(lost).draft_id;

  // The card retries with what it has: the OLD id and the same patch.
  const retry = await runDraftEditorSave(m.deps, CALLER, patch);
  assertEquals(retry.result.isError, false, "not draft_not_found");
  assertEquals(draftOf(retry).draft_id, afterFirst, "the draft the first attempt wrote");
  assertEquals(draftOf(retry).recipients.cc, ["hello@mcpemails.com"]);
  assertEquals(draftOf(retry).last_saved_by, "user");

  // One draft in the mailbox, written once: no duplicate, no second rewrite.
  assertEquals([...m.drafts.keys()], [afterFirst]);
  assertEquals(m.writes.length, 1);
});

Deno.test("a retried save that carries a further change is applied to the current draft", async () => {
  const m = mailbox();
  const first = await m.agentCreates(signedDraft("Here they are."));
  await runDraftEditorSave(m.deps, CALLER, { draft_id: first, subject: "Q3 numbers" });
  const again = await runDraftEditorSave(m.deps, CALLER, { draft_id: first, subject: "Q3 numbers, final" });
  assertEquals(again.result.isError, false);
  assertEquals(m.drafts.size, 1, "still one draft");
  assertEquals(m.drafts.get(draftOf(again).draft_id)!.subject, "Q3 numbers, final");
  // And every id the draft ever had now resolves to it.
  const read = await runDraftRead(m.deps, CALLER, { draft_id: first });
  assertEquals(draftOf(read).draft_id, draftOf(again).draft_id);
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
  // Still "embedded" (the words are in the text), no longer `rich`.
  assertEquals(draft.signature, { embedded: true });
  assertEquals(m.drafts.get(draft.draft_id)!.bodyHtml, null, "no HTML part was written");
  assertEquals(m.drafts.get(draft.draft_id)!.bodyText, `${stored.bodyText}xx`);
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

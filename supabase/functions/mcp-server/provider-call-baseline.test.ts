// ---------------------------------------------------------------------------
// provider-call-baseline.test.ts — what three tools return, and which Gmail /
// Graph requests they make, pinned BEFORE the way those requests are scheduled
// was touched.
//
// The three paths:
//
//   draft_list        (Gmail)            drafts.list, then one messages.get
//                                        per draft
//   email_read_batch  (Gmail, Outlook)   one read per message id, sharing a
//                                        body budget that is spent in order
//   email_list        (Gmail)            messages.list, labels.get for the
//                                        exact total, one messages.get per row
//
// Every test in this file was written and run green against the code as it
// stood when each of those issued its requests one after another. It is the
// definition of "no change in behaviour" for any later work on HOW they are
// issued, so the assertions here are not to be edited to suit such work: if
// one fails, the change is wrong.
//
// What is pinned, for each path:
//   * the tool result, twice over: `structuredContent` against a literal, and
//     `content[0].text` against the exact string;
//   * the provider requests made (method + URL with its query), as a multiset;
//   * their order, only where the result or the provider can tell.
//
// ONE DELIBERATE GAP, stated here rather than hidden. A batch read can stop
// early in two ways: an auth failure (the whole call becomes the reconnect
// message) and the wall-clock budget running out (the ids not reached are
// reported as remaining). When either happens AFTER at least one message has
// been read successfully, this file pins the result exactly, that every
// message up to the stopping point was requested exactly once, and that
// nothing was requested twice or outside the batch — but NOT that the ids
// after the stopping point were left unrequested. Whether a read of message 4
// had already been issued when message 3 turned out to be the last is not
// something the caller can see, and it is the one thing reading ahead changes.
// While no message has yet been read successfully (a dead token, an account
// with no mailbox, a batch of stale ids) the requests ARE pinned exactly.
//
// The network is provider-call-harness.ts. Every mailbox, address, subject and
// body is invented.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env \
//        supabase/functions/mcp-server/provider-call-baseline.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ACCESS_TOKEN,
  alreadyExpired,
  API_KEY,
  executeListDrafts,
  executeListInbox,
  executeReadEmails,
  type FakeGmailMessage,
  type FakeGraphMessage,
  gmailFull,
  gmailMeta,
  graphMessage,
  INBOX_ID,
  inboxRow,
  json,
  messageIdOf,
  type ProviderCall,
  type ProviderHandler,
  requestMultiset,
  requestSequence,
  runTool,
  type World,
} from "./provider-call-harness.ts";
import { batchBodyAllowance, singleReadContinuation, windowBody } from "./body-window.ts";
import { bulkPartialFields } from "./bulk-budget.ts";

// ── Shapes ──────────────────────────────────────────────────────────────────

interface ToolOutcome {
  result: {
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  logStatus: string;
  logErrorCode: string | null;
}

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GRAPH = "https://graph.microsoft.com/v1.0";
const GRAPH_SELECT =
  "$select=id,conversationId,from,toRecipients,ccRecipients,replyTo,subject,receivedDateTime,body,hasAttachments,isRead,internetMessageId,internetMessageHeaders,categories,flag";

const gmailFullUrl = (id: string) => `GET ${GMAIL}/messages/${id}?format=full`;
const graphReadUrl = (id: string) => `GET ${GRAPH}/me/messages/${id}?${GRAPH_SELECT}`;
const draftMetaUrl = (id: string) =>
  `GET ${GMAIL}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Date`;
const listMetaUrl = (id: string) =>
  `GET ${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`;

const GMAIL_AUTH_FAILED =
  "Unable to access the gmail inbox: its OAuth token has been revoked or expired, so the inbox has been marked 'error'. " +
  "Ask the user to reconnect it by opening this link in their browser (they may need to sign in to MCP Emails first): " +
  `https://mcpemails.com/auth/gmail?inbox=${INBOX_ID}`;
const OUTLOOK_AUTH_FAILED =
  "Unable to access the outlook inbox: its OAuth token has been revoked or expired, so the inbox has been marked 'error'. " +
  "Ask the user to reconnect it by opening this link in their browser (they may need to sign in to MCP Emails first): " +
  `https://mcpemails.com/auth/outlook?inbox=${INBOX_ID}`;
const NOT_FOUND_ENTRY =
  "Message not found. The message may have been deleted or the ID is stale — " +
  "call email_list or email_search to get current message IDs.";

/** A success result: the structured value AND the exact text, both. */
function assertJsonResult(outcome: ToolOutcome, expected: Record<string, unknown>, pretty = false) {
  assertEquals(outcome.result.structuredContent, expected);
  assertEquals(outcome.result.content.length, 1);
  assertEquals(outcome.result.content[0].type, "text");
  assertEquals(
    outcome.result.content[0].text,
    pretty ? JSON.stringify(expected, null, 2) : JSON.stringify(expected),
  );
  assertEquals(outcome.logStatus, "success");
  assertEquals(outcome.logErrorCode, null);
}

/** An error result: the exact text, no structured content, the log code. */
function assertErrorResult(outcome: ToolOutcome, text: string, code: string) {
  assertEquals(outcome.result.content, [{ type: "text", text }]);
  assertEquals(outcome.result.isError, true);
  assertEquals(outcome.result.structuredContent, undefined);
  assertEquals(outcome.logStatus, "error");
  assertEquals(outcome.logErrorCode, code);
}

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// draft_list — Gmail
// ═══════════════════════════════════════════════════════════════════════════

const DRAFT_LIST_URL = (max: number) => `GET ${GMAIL}/drafts?maxResults=${max}`;

interface FakeDraft {
  id: string;
  messageId: string;
  subject: string;
  to: string;
  cc: string;
  /** How the messages.get for this draft goes wrong, if it does. */
  fail?: "500" | "404" | "401" | "429" | "reject" | "not_json";
}

function draftAt(i: number, fail?: FakeDraft["fail"]): FakeDraft {
  const n = String(i + 1).padStart(2, "0");
  return {
    id: `draft-${n}`,
    messageId: `dm${n}`,
    subject: `Quarterly notes ${n}`,
    to: `Reader ${n} <reader${n}@drafts.example>`,
    cc: i % 3 === 0 ? `copy${n}@drafts.example` : "",
    fail,
  };
}

function expectedDraft(d: FakeDraft, i: number): Record<string, unknown> {
  const n = String(i + 1).padStart(2, "0");
  return {
    draft_id: d.id,
    subject: d.subject,
    to: [{ name: `Reader ${n}`, email: `reader${n}@drafts.example` }],
    cc: i % 3 === 0 ? [{ name: "", email: `copy${n}@drafts.example` }] : [],
    // internalDate below is 1767225600000 + i seconds.
    created_at: new Date(1767225600000 + i * 1000).toISOString(),
  };
}

function draftHandler(drafts: FakeDraft[]): ProviderHandler {
  return (call) => {
    if (call.url.includes("/drafts?")) {
      return json({ drafts: drafts.map((d) => ({ id: d.id, message: { id: d.messageId } })) });
    }
    const id = messageIdOf(call);
    const i = drafts.findIndex((d) => d.messageId === id);
    const d = drafts[i];
    if (!d) return json({ error: { message: "unexpected" } }, 418);
    switch (d.fail) {
      case "500":
        return json({ error: { message: "backend error" } }, 500);
      case "404":
        return json({ error: { message: "Requested entity was not found." } }, 404);
      case "401":
        return json({ error: { message: "Invalid Credentials" } }, 401);
      case "429":
        return json({ error: { message: "Too many concurrent requests for user" } }, 429);
      case "reject":
        throw new TypeError("connection reset");
      case "not_json":
        return new Response("<html>gateway</html>", { status: 200 });
    }
    return json(gmailMeta({
      id,
      subject: d.subject,
      to: d.to,
      cc: d.cc,
      internalDate: String(1767225600000 + i * 1000),
    }));
  };
}

async function listDrafts(drafts: FakeDraft[], args: Record<string, unknown> = {}) {
  const inbox = await inboxRow("gmail");
  const run = await runTool(
    inbox,
    draftHandler(drafts),
    () => executeListDrafts({ inbox_id: INBOX_ID, ...args }, API_KEY) as Promise<ToolOutcome>,
  );
  return run;
}

Deno.test("draft_list (gmail): a typical page, every field, in drafts.list order", async () => {
  const drafts = [draftAt(0), draftAt(1), draftAt(2)];
  const { value, world } = await listDrafts(drafts);
  const expected = {
    inbox_id: INBOX_ID,
    drafts: [
      {
        draft_id: "draft-01",
        subject: "Quarterly notes 01",
        to: [{ name: "Reader 01", email: "reader01@drafts.example" }],
        cc: [{ name: "", email: "copy01@drafts.example" }],
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        draft_id: "draft-02",
        subject: "Quarterly notes 02",
        to: [{ name: "Reader 02", email: "reader02@drafts.example" }],
        cc: [],
        created_at: "2026-01-01T00:00:01.000Z",
      },
      {
        draft_id: "draft-03",
        subject: "Quarterly notes 03",
        to: [{ name: "Reader 03", email: "reader03@drafts.example" }],
        cc: [],
        created_at: "2026-01-01T00:00:02.000Z",
      },
    ],
    untrusted_content: true,
  };
  assertJsonResult(value, expected, true);
  assertEquals(
    requestMultiset(world),
    [DRAFT_LIST_URL(20), draftMetaUrl("dm01"), draftMetaUrl("dm02"), draftMetaUrl("dm03")].sort(),
  );
  // The listing is asked for first; nothing can be fetched before it answers.
  assertEquals(requestSequence(world)[0], DRAFT_LIST_URL(20));
  for (const call of world.calls) assertEquals(call.bearer, ACCESS_TOKEN);
});

Deno.test("draft_list (gmail): no drafts makes one request and returns an empty list", async () => {
  const { value, world } = await listDrafts([]);
  assertJsonResult(value, { inbox_id: INBOX_ID, drafts: [], untrusted_content: true }, true);
  assertEquals(requestSequence(world), [DRAFT_LIST_URL(20)]);

  // `drafts` absent altogether, which is how Gmail spells an empty mailbox.
  const inbox = await inboxRow("gmail");
  const bare = await runTool(
    inbox,
    () => json({ resultSizeEstimate: 0 }),
    () => executeListDrafts({ inbox_id: INBOX_ID }, API_KEY) as Promise<ToolOutcome>,
  );
  assertJsonResult(bare.value, { inbox_id: INBOX_ID, drafts: [], untrusted_content: true }, true);
  assertEquals(requestSequence(bare.world), [DRAFT_LIST_URL(20)]);
});

Deno.test("draft_list (gmail): the maximum page is 50, in order, one get per draft", async () => {
  const drafts = Array.from({ length: 50 }, (_, i) => draftAt(i));
  const expected = { inbox_id: INBOX_ID, drafts: drafts.map(expectedDraft), untrusted_content: true };
  for (const limit of [50, 999]) {
    const { value, world } = await listDrafts(drafts, { limit });
    assertJsonResult(value, expected, true);
    assertEquals(
      requestMultiset(world),
      [DRAFT_LIST_URL(50), ...drafts.map((d) => draftMetaUrl(d.messageId))].sort(),
    );
  }
  // The default page asks Gmail for 20.
  const defaulted = await listDrafts(drafts.slice(0, 20));
  assertJsonResult(
    defaulted.value,
    { inbox_id: INBOX_ID, drafts: drafts.slice(0, 20).map(expectedDraft), untrusted_content: true },
    true,
  );
  assertEquals(requestSequence(defaulted.world)[0], DRAFT_LIST_URL(20));
});

Deno.test("draft_list (gmail): a draft whose get fails is LEFT OUT, wherever it sits, and nothing else moves", async () => {
  const kinds: NonNullable<FakeDraft["fail"]>[] = ["500", "404", "401", "429", "reject", "not_json"];
  for (const kind of kinds) {
    for (const position of [0, 3, 6]) {
      const drafts = Array.from({ length: 7 }, (_, i) => draftAt(i, i === position ? kind : undefined));
      const { value, world } = await listDrafts(drafts);
      const kept = drafts.map(expectedDraft).filter((_, i) => i !== position);
      assertJsonResult(value, { inbox_id: INBOX_ID, drafts: kept, untrusted_content: true }, true);
      // The failing draft was still asked for, once, like every other.
      assertEquals(
        requestMultiset(world),
        [DRAFT_LIST_URL(20), ...drafts.map((d) => draftMetaUrl(d.messageId))].sort(),
        `${kind} at ${position}`,
      );
    }
  }
});

Deno.test("draft_list (gmail): several failures at once, including a 401 on a get, are all just left out", async () => {
  // A 401 on a per-draft get is NOT an auth failure for the call: only the
  // listing's own 401 is. Odd, and exactly what the tool does today.
  const fails: Record<number, FakeDraft["fail"]> = { 0: "401", 1: "500", 4: "reject", 8: "429", 9: "401" };
  const drafts = Array.from({ length: 10 }, (_, i) => draftAt(i, fails[i]));
  const { value, world } = await listDrafts(drafts);
  const kept = drafts.map(expectedDraft).filter((_, i) => !(i in fails));
  assertEquals(kept.map((d) => d.draft_id), ["draft-03", "draft-04", "draft-06", "draft-07", "draft-08"]);
  assertJsonResult(value, { inbox_id: INBOX_ID, drafts: kept, untrusted_content: true }, true);
  assertEquals(
    requestMultiset(world),
    [DRAFT_LIST_URL(20), ...drafts.map((d) => draftMetaUrl(d.messageId))].sort(),
  );
});

Deno.test("draft_list (gmail): every get failing returns an empty list, not an error", async () => {
  const drafts = Array.from({ length: 4 }, (_, i) => draftAt(i, "500"));
  const { value } = await listDrafts(drafts);
  assertJsonResult(value, { inbox_id: INBOX_ID, drafts: [], untrusted_content: true }, true);
});

Deno.test("draft_list (gmail): a listing entry with no message is left out without a request", async () => {
  const inbox = await inboxRow("gmail");
  const { value, world } = await runTool(
    inbox,
    (call) => {
      if (call.url.includes("/drafts?")) {
        return json({ drafts: [{ id: "draft-01", message: { id: "dm01" } }, { id: "draft-orphan" }, {
          id: "draft-03",
          message: { id: "dm03" },
        }] });
      }
      return json(gmailMeta({ id: messageIdOf(call), subject: "Kept", to: "a@drafts.example", internalDate: "1767225600000" }));
    },
    () => executeListDrafts({ inbox_id: INBOX_ID }, API_KEY) as Promise<ToolOutcome>,
  );
  assertJsonResult(value, {
    inbox_id: INBOX_ID,
    drafts: ["draft-01", "draft-03"].map((draft_id) => ({
      draft_id,
      subject: "Kept",
      to: [{ name: "", email: "a@drafts.example" }],
      cc: [],
      created_at: "2026-01-01T00:00:00.000Z",
    })),
    untrusted_content: true,
  }, true);
  assertEquals(requestMultiset(world), [DRAFT_LIST_URL(20), draftMetaUrl("dm01"), draftMetaUrl("dm03")].sort());
});

Deno.test("draft_list (gmail): the listing's own failure is the call's failure", async () => {
  const inbox = await inboxRow("gmail");
  const cases: [number, string, string, string][] = [
    [401, "Unauthorized", GMAIL_AUTH_FAILED, "auth_failed"],
    [500, "Internal Server Error", "Failed to list drafts for gmail inbox: Gmail drafts.list error: Internal Server Error", "provider_error"],
    [429, "Too Many Requests", "Failed to list drafts for gmail inbox: Gmail drafts.list error: Too Many Requests", "provider_error"],
  ];
  for (const [status, statusText, text, code] of cases) {
    const { value, world } = await runTool(
      inbox,
      () => new Response("{}", { status, statusText }),
      () => executeListDrafts({ inbox_id: INBOX_ID }, API_KEY) as Promise<ToolOutcome>,
    );
    assertErrorResult(value, text, code);
    assertEquals(requestSequence(world), [DRAFT_LIST_URL(20)]);
  }
});

Deno.test("draft_list (gmail): an expired token is refreshed ONCE and every request carries the new one", async () => {
  const inbox = await inboxRow("gmail", { oauth_token_expires_at: alreadyExpired() });
  const drafts = Array.from({ length: 6 }, (_, i) => draftAt(i));
  const provider = draftHandler(drafts);
  const { value, world } = await runTool(
    inbox,
    (call) => {
      if (call.host === "oauth2.googleapis.com") return json({ access_token: "refreshed-gmail-token", expires_in: 3600 });
      return provider(call);
    },
    () => executeListDrafts({ inbox_id: INBOX_ID }, API_KEY) as Promise<ToolOutcome>,
  );
  assertJsonResult(value, { inbox_id: INBOX_ID, drafts: drafts.map(expectedDraft), untrusted_content: true }, true);
  assertEquals(
    requestMultiset(world),
    ["POST https://oauth2.googleapis.com/token", DRAFT_LIST_URL(20), ...drafts.map((d) => draftMetaUrl(d.messageId))].sort(),
  );
  assertEquals(requestSequence(world)[0], "POST https://oauth2.googleapis.com/token");
  for (const call of world.calls.slice(1)) assertEquals(call.bearer, "refreshed-gmail-token");
  assertEquals(world.db.filter((d) => d.method === "PATCH").length, 1, "one token persist");
});

// ═══════════════════════════════════════════════════════════════════════════
// email_read_batch — the shared expectation
// ═══════════════════════════════════════════════════════════════════════════

/** What the provider holds for one id: a message, or the way reading it fails. */
type Stored<M> =
  | { message: M }
  | { fail: "500" | "404" | "400" | "403" | "429" | "reject" };

/**
 * The body windows a batch read applies, re-derived from the documented rule
 * rather than read back from the tool: the allowance for a message is the
 * remaining budget divided by the messages not yet reached, capped per
 * message; an errored id spends nothing; text and html each get the allowance
 * and both are charged.
 *
 * `windowBody` and `batchBodyAllowance` are the pure functions in
 * body-window.ts. They have their own suite and no scheduling in them, so
 * using them here as the reference for "what a serial pass produces" does not
 * make this circular: what is under test is the ORDER the batch feeds them in.
 */
function serialWindows(
  entries: { id: string; text: string | null; html: string | null; errored: boolean }[],
  perMessageCap: number,
): Array<Record<string, unknown> | null> {
  let remaining = 24_000;
  let left = entries.length;
  return entries.map((entry) => {
    const allowance = batchBodyAllowance(perMessageCap, remaining, left);
    left--;
    if (entry.errored) return null;
    const text = windowBody(entry.text, {
      offset: 0,
      maxChars: allowance,
      prefix: "body",
      recovery: (next) => singleReadContinuation(entry.id, next, false),
    });
    const html = windowBody(entry.html, {
      offset: 0,
      maxChars: allowance,
      prefix: "body_html",
      recovery: (next) => singleReadContinuation(entry.id, next, true),
    });
    remaining -= (text.text?.length ?? 0) + (html.text?.length ?? 0);
    return { body_text: text.text, body_html: html.text, textFields: text.fields, htmlFields: html.fields };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// email_read_batch — Gmail
// ═══════════════════════════════════════════════════════════════════════════

function gmailStored(id: string, text: string, html?: string): Stored<FakeGmailMessage> {
  return {
    message: {
      id,
      from: `Sender ${id} <sender-${id}@mail.example>`,
      to: "owner@gmail-harness.example",
      subject: `Subject ${id}`,
      text,
      html,
      labelIds: ["INBOX", "UNREAD"],
      internalDate: "1767225600000",
    },
  };
}

function gmailReadHandler(store: Record<string, Stored<FakeGmailMessage>>): ProviderHandler {
  return (call) => {
    const id = messageIdOf(call);
    const entry = store[id];
    if (!entry) return json({ error: { message: "Requested entity was not found." } }, 404);
    if ("fail" in entry) {
      switch (entry.fail) {
        case "500":
          return json({ error: { message: "Backend Error" } }, 500);
        case "404":
          return json({ error: { message: "Requested entity was not found." } }, 404);
        case "400":
          return json({ error: { message: "Invalid id value" } }, 400);
        case "403":
          return json({ error: { message: "Insufficient Permission" } }, 403);
        case "429":
          return json({ error: { message: "Too many concurrent requests for user" } }, 429);
        case "reject":
          throw new TypeError("connection reset");
      }
    }
    return json(gmailFull(entry.message));
  };
}

const GMAIL_ERROR_TEXT: Record<string, string> = {
  "500": "Provider error: Gmail API error: Backend Error",
  "404": NOT_FOUND_ENTRY,
  "400": NOT_FOUND_ENTRY,
  "403": "Provider error: Gmail API error: Insufficient Permission",
  "429": "Provider error: Gmail API error: Too many concurrent requests for user",
  "reject": "Provider error: connection reset",
};

/** The whole expected `email_read_batch` payload for a Gmail store. */
function expectedGmailBatch(
  order: string[],
  store: Record<string, Stored<FakeGmailMessage>>,
  opts: { includeHtml?: boolean; cap?: number } = {},
): Record<string, unknown> {
  const windows = serialWindows(
    order.map((id) => {
      const entry = store[id];
      if (!entry || "fail" in entry) return { id, text: null, html: null, errored: true };
      return {
        id,
        text: entry.message.text ?? null,
        html: opts.includeHtml ? entry.message.html ?? null : null,
        errored: false,
      };
    }),
    opts.cap ?? 2_000,
  );
  const messages: Record<string, unknown>[] = [];
  const errors: { message_id: string; error: string }[] = [];
  order.forEach((id, i) => {
    const entry = store[id];
    if (!entry || "fail" in entry) {
      errors.push({ message_id: id, error: GMAIL_ERROR_TEXT[entry ? entry.fail : "404"] });
      return;
    }
    const w = windows[i]!;
    messages.push({
      id,
      thread_id: `thread-${id}`,
      from: { name: `Sender ${id}`, email: `sender-${id}@mail.example` },
      to: [{ name: "", email: "owner@gmail-harness.example" }],
      cc: [],
      bcc: [],
      reply_to: null,
      subject: `Subject ${id}`,
      date: "2026-01-01T00:00:00.000Z",
      body_text: w.body_text,
      body_html: w.body_html,
      attachments: [],
      is_read: false,
      labels: ["INBOX", "UNREAD"],
      in_reply_to: null,
      references: [],
      ...(w.textFields as Record<string, unknown>),
      ...(w.htmlFields as Record<string, unknown>),
    });
  });
  return { messages, errors, untrusted_content: true };
}

async function readGmail(
  store: Record<string, Stored<FakeGmailMessage>>,
  args: Record<string, unknown>,
  handler: ProviderHandler = gmailReadHandler(store),
  inboxOverrides: Record<string, unknown> = {},
) {
  const inbox = await inboxRow("gmail", inboxOverrides);
  return await runTool(
    inbox,
    handler,
    () => executeReadEmails({ inbox_id: INBOX_ID, ...args }, API_KEY) as Promise<ToolOutcome>,
  );
}

Deno.test("email_read_batch (gmail): three ordinary messages, every field, whole bodies", async () => {
  const store: Record<string, Stored<FakeGmailMessage>> = {
    ga: {
      message: {
        id: "ga",
        threadId: "thread-shared",
        from: "Ingrid Solberg <ingrid@fjord-post.example>",
        to: "owner@gmail-harness.example, Second Reader <second@fjord-post.example>",
        cc: "Team <team@fjord-post.example>",
        subject: "Agenda for Thursday",
        text: "Hei,\n\nHere is the agenda.\n\n1. Budget\n2. Hiring\n",
        html: "<p>Hei,</p><p>Here is the agenda.</p>",
        labelIds: ["INBOX", "UNREAD", "IMPORTANT"],
        internalDate: "1767312000000",
      },
    },
    gb: {
      message: {
        id: "gb",
        from: "billing@invoices.example",
        to: "owner@gmail-harness.example",
        subject: "Invoice 1042",
        text: "Your invoice is attached. Total: 1 250,00 kr.",
        labelIds: ["INBOX"],
        internalDate: "1767398400000",
      },
    },
    gc: {
      message: {
        id: "gc",
        from: "Newsletter <news@letters.example>",
        to: "owner@gmail-harness.example",
        subject: "Weekly digest",
        html: "<h1>Digest</h1><p>Three stories this week.</p>",
        labelIds: ["CATEGORY_PROMOTIONS"],
        internalDate: "1767484800000",
      },
    },
  };
  const { value, world } = await readGmail(store, { message_ids: ["ga", "gb", "gc"] });
  assertJsonResult(value, {
    messages: [
      {
        id: "ga",
        thread_id: "thread-shared",
        from: { name: "Ingrid Solberg", email: "ingrid@fjord-post.example" },
        to: [
          { name: "", email: "owner@gmail-harness.example" },
          { name: "Second Reader", email: "second@fjord-post.example" },
        ],
        cc: [{ name: "Team", email: "team@fjord-post.example" }],
        bcc: [],
        reply_to: null,
        subject: "Agenda for Thursday",
        date: "2026-01-02T00:00:00.000Z",
        body_text: "Hei,\n\nHere is the agenda.\n\n1. Budget\n2. Hiring\n",
        body_html: null,
        attachments: [],
        is_read: false,
        labels: ["INBOX", "UNREAD", "IMPORTANT"],
        in_reply_to: null,
        references: [],
      },
      {
        id: "gb",
        thread_id: "thread-gb",
        from: { name: "", email: "billing@invoices.example" },
        to: [{ name: "", email: "owner@gmail-harness.example" }],
        cc: [],
        bcc: [],
        reply_to: null,
        subject: "Invoice 1042",
        date: "2026-01-03T00:00:00.000Z",
        body_text: "Your invoice is attached. Total: 1 250,00 kr.",
        body_html: null,
        attachments: [],
        is_read: true,
        labels: ["INBOX"],
        in_reply_to: null,
        references: [],
      },
      {
        id: "gc",
        thread_id: "thread-gc",
        from: { name: "Newsletter", email: "news@letters.example" },
        to: [{ name: "", email: "owner@gmail-harness.example" }],
        cc: [],
        bcc: [],
        reply_to: null,
        subject: "Weekly digest",
        date: "2026-01-04T00:00:00.000Z",
        // Exactly what the HTML-to-text pass yields today for adjacent blocks.
        body_text: "DigestThree stories this week.",
        body_html: null,
        attachments: [],
        is_read: true,
        labels: ["CATEGORY_PROMOTIONS"],
        in_reply_to: null,
        references: [],
      },
    ],
    errors: [],
    untrusted_content: true,
  });
  assertEquals(value.result.isError, false);
  assertEquals(requestMultiset(world), ["ga", "gb", "gc"].map(gmailFullUrl).sort());
  for (const call of world.calls) assertEquals(call.bearer, ACCESS_TOKEN);
});

Deno.test("email_read_batch: empty and oversized input is refused before any request", async () => {
  for (const provider of ["gmail", "outlook"] as const) {
    const inbox = await inboxRow(provider);
    const refuse = async (args: unknown) =>
      await runTool(inbox, () => json({}), () => executeReadEmails(args, API_KEY) as Promise<ToolOutcome>);

    for (const message_ids of [[], ["", "   "], [7, null], undefined]) {
      const { value, world } = await refuse({ inbox_id: INBOX_ID, message_ids });
      assertErrorResult(
        value,
        "email_read_batch: message_ids is required and must be a non-empty array of strings.",
        "-32602",
      );
      assertEquals(world.calls.length, 0);
      assertEquals(world.db.length, 0, "refused before the inbox is even looked up");
    }

    const tooMany = await refuse({ inbox_id: INBOX_ID, message_ids: ids("m", 51) });
    assertErrorResult(
      tooMany.value,
      JSON.stringify({
        error: "too_many_message_ids",
        max: 50,
        received: 51,
        message: "email_read_batch accepts at most 50 message IDs per call. Received 51. Split the request into smaller batches.",
      }),
      "-32602",
    );
    assertEquals(tooMany.world.calls.length, 0);

    const notObject = await refuse(["m1"]);
    assertErrorResult(
      notObject.value,
      "email_read_batch: arguments must be an object with message_ids and an inbox.",
      "-32602",
    );
  }
});

Deno.test("email_read_batch (gmail): the maximum batch is 50 messages, each read once, in the order asked", async () => {
  const order = ids("g", 50);
  const store: Record<string, Stored<FakeGmailMessage>> = {};
  order.forEach((id, i) => store[id] = gmailStored(id, `Body of ${id}. `.repeat(1 + (i % 7))));
  const { value, world } = await readGmail(store, { message_ids: order });
  assertJsonResult(value, expectedGmailBatch(order, store));
  const messages = value.result.structuredContent!.messages as { id: string; body_truncated?: boolean }[];
  assertEquals(messages.map((m) => m.id), order);
  assert(messages.every((m) => m.body_truncated === undefined), "5 KB of body fits the 24 KB budget whole");
  assertEquals(requestMultiset(world), order.map(gmailFullUrl).sort());
});

Deno.test("email_read_batch (gmail): ids are trimmed and de-duplicated, first occurrence keeps its place", async () => {
  const store = { ga: gmailStored("ga", "first"), gb: gmailStored("gb", "second") };
  const { value, world } = await readGmail(store, { message_ids: ["gb", " ga ", "gb", "", "ga", 12] });
  assertJsonResult(value, expectedGmailBatch(["gb", "ga"], store));
  assertEquals(requestMultiset(world), ["ga", "gb"].map(gmailFullUrl).sort());
});

/**
 * Twenty messages whose sizes are chosen so the order they are charged in
 * shows up in every later window: big, tiny, an id that fails, and bodies of
 * astral characters, where a cut may only land on a pair boundary and so
 * shifts by one depending on the allowance it was handed.
 */
function budgetStore(): { order: string[]; store: Record<string, Stored<FakeGmailMessage>> } {
  const order = ids("b", 20);
  const store: Record<string, Stored<FakeGmailMessage>> = {};
  const sizes = [5000, 40, 3000, 0, 2600, 9, 2600, 2600, 700, 2600, 2600, 2600, 15, 2600, 2600, 2600, 2600, 2600, 2600, 2600];
  order.forEach((id, i) => {
    if (i === 3) {
      store[id] = { fail: "500" };
      return;
    }
    const unit = i % 4 === 2 ? "\u{1F4EC}" : String.fromCharCode(97 + (i % 26));
    const text = unit.repeat(Math.ceil(sizes[i] / unit.length)) + (i % 5 === 0 ? "!" : "");
    store[id] = gmailStored(id, text, `<p>${text}</p>`);
  });
  return { order, store };
}

Deno.test("email_read_batch (gmail): bodies that exhaust the batch budget part-way are cut exactly where a serial pass cuts them", async () => {
  const { order, store } = budgetStore();
  const { value, world } = await readGmail(store, { message_ids: order });
  assertJsonResult(value, expectedGmailBatch(order, store));

  // The same thing spelled as numbers, so the pin does not rest on the
  // reference function alone. Emitted characters per message, in order.
  const messages = value.result.structuredContent!.messages as {
    id: string;
    body_text: string;
    body_truncated?: boolean;
    body_next_offset?: number;
  }[];
  assertEquals(
    messages.map((m) => m.body_text.length),
    [1200, 40, 1264, 1343, 10, 1438, 1438, 700, 1506, 1506, 1506, 15, 1719, 1718, 1719, 1719, 1719, 1720, 1720],
  );
  assertEquals(
    messages.map((m) => m.body_truncated ?? false),
    [true, false, true, true, false, true, true, false, true, true, true, false, true, true, true, true, true, true, true],
  );
  assertEquals(value.result.structuredContent!.errors, [
    { message_id: "b04", error: "Provider error: Gmail API error: Backend Error" },
  ]);
  assertEquals(requestMultiset(world), order.map(gmailFullUrl).sort());
});

Deno.test("email_read_batch (gmail): with include_html both bodies are charged, and the windows shrink to almost nothing", async () => {
  const { order, store } = budgetStore();
  const { value, world } = await readGmail(store, { message_ids: order, include_html: true, body_max_chars: 6000 });
  assertJsonResult(value, expectedGmailBatch(order, store, { includeHtml: true, cap: 6000 }));

  const messages = value.result.structuredContent!.messages as {
    id: string;
    body_text: string;
    body_html: string;
    body_truncated?: boolean;
    body_next_offset?: number;
    body_html_next_offset?: number;
  }[];
  assertEquals(
    messages.map((m) => [m.body_text.length, m.body_html.length]),
    [
      [1200, 1200],
      [40, 47],
      [1194, 1195],
      [1195, 1195],
      [10, 17],
      [1192, 1193],
      [1101, 1101],
      [700, 707],
      [973, 973],
      [876, 875],
      [779, 779],
      [15, 22],
      [774, 774],
      [644, 645],
      [516, 516],
      [388, 388],
      [258, 258],
      [130, 129],
      [1, 1],
    ],
  );
  // The last message is left one character of each body, and says where the
  // rest is.
  const last = messages[messages.length - 1];
  assertEquals([last.id, last.body_truncated, last.body_next_offset, last.body_html_next_offset], ["b20", true, 1, 1]);
  assertEquals(requestMultiset(world), order.map(gmailFullUrl).sort());
});

Deno.test("email_read_batch (gmail): body_max_chars 0 is headers only, and a small cap applies per message", async () => {
  const order = ids("g", 4);
  const store: Record<string, Stored<FakeGmailMessage>> = {};
  order.forEach((id, i) => store[id] = gmailStored(id, "word ".repeat(100 * (i + 1))));
  for (const cap of [0, 300]) {
    const { value } = await readGmail(store, { message_ids: order, body_max_chars: cap });
    assertJsonResult(value, expectedGmailBatch(order, store, { cap }));
    const messages = value.result.structuredContent!.messages as { body_text: string }[];
    assertEquals(messages.map((m) => m.body_text.length), cap === 0 ? [0, 0, 0, 0] : [300, 300, 300, 300]);
  }
});

Deno.test("email_read_batch (gmail): one failing message becomes one error entry, in place, for every kind and position", async () => {
  const order = ids("g", 6);
  for (const kind of ["500", "404", "400", "403", "429", "reject"] as const) {
    for (const position of [0, 2, 5]) {
      const store: Record<string, Stored<FakeGmailMessage>> = {};
      order.forEach((id, i) => store[id] = i === position ? { fail: kind } : gmailStored(id, `Body of ${id}`));
      const { value, world } = await readGmail(store, { message_ids: order });
      assertJsonResult(value, expectedGmailBatch(order, store));
      assertEquals(value.result.structuredContent!.errors, [
        { message_id: order[position], error: GMAIL_ERROR_TEXT[kind] },
      ]);
      assertEquals(
        (value.result.structuredContent!.messages as { id: string }[]).map((m) => m.id),
        order.filter((_, i) => i !== position),
      );
      assertEquals(requestMultiset(world), order.map(gmailFullUrl).sort(), `${kind} at ${position}`);
    }
  }
});

Deno.test("email_read_batch (gmail): several failures keep the order they were asked in", async () => {
  const order = ids("g", 9);
  const fails: Record<number, "500" | "404" | "429" | "reject"> = { 0: "404", 1: "500", 4: "reject", 7: "429", 8: "404" };
  const store: Record<string, Stored<FakeGmailMessage>> = {};
  order.forEach((id, i) => store[id] = fails[i] ? { fail: fails[i] } : gmailStored(id, "x".repeat(4000)));
  const { value, world } = await readGmail(store, { message_ids: order });
  assertJsonResult(value, expectedGmailBatch(order, store));
  assertEquals(value.result.structuredContent!.errors, [
    { message_id: "g01", error: NOT_FOUND_ENTRY },
    { message_id: "g02", error: "Provider error: Gmail API error: Backend Error" },
    { message_id: "g05", error: "Provider error: connection reset" },
    { message_id: "g08", error: "Provider error: Gmail API error: Too many concurrent requests for user" },
    { message_id: "g09", error: NOT_FOUND_ENTRY },
  ]);
  // The server's own log of the non-not-found failures, in the order asked.
  assertEquals(
    world.console.filter((l) => l.level === "error").map((l) => (l.args[1] as { message_id: string }).message_id),
    ["g02", "g05", "g08"],
  );
  assertEquals(requestMultiset(world), order.map(gmailFullUrl).sort());
});

Deno.test("email_read_batch (gmail): every message failing is still a success with only errors", async () => {
  const order = ids("g", 5);
  const store: Record<string, Stored<FakeGmailMessage>> = {};
  order.forEach((id) => store[id] = { fail: "404" });
  const { value } = await readGmail(store, { message_ids: order });
  assertJsonResult(value, {
    messages: [],
    errors: order.map((message_id) => ({ message_id, error: NOT_FOUND_ENTRY })),
    untrusted_content: true,
  });
});

/**
 * The requests around a fatal failure at `position`: everything up to and
 * including it exactly once, nothing twice, nothing outside the batch.
 */
function assertRequestsAroundFatal(world: World, order: string[], position: number, url: (id: string) => string) {
  const made = world.calls.filter((c) => c.host !== "oauth2.googleapis.com" && !c.host.includes("microsoftonline"))
    .map((c) => `${c.method} ${c.url}`);
  assertEquals(new Set(made).size, made.length, "no message is requested twice");
  const allowed = new Set(order.map(url));
  for (const m of made) assert(allowed.has(m), `unexpected request ${m}`);
  for (const id of order.slice(0, position + 1)) assert(made.includes(url(id)), `${id} must have been requested`);
}

Deno.test("email_read_batch (gmail): a 401 on any message is fatal for the whole call", async () => {
  const order = ids("g", 9);
  for (const position of [0, 4, 8]) {
    const store: Record<string, Stored<FakeGmailMessage>> = {};
    order.forEach((id) => store[id] = gmailStored(id, `Body of ${id}`));
    // An earlier, non-fatal error must not survive into the result either.
    if (position > 1) store[order[1]] = { fail: "500" };
    const base = gmailReadHandler(store);
    const { value, world } = await readGmail(store, { message_ids: order }, (call) => {
      if (messageIdOf(call) === order[position]) return json({ error: { message: "Invalid Credentials" } }, 401);
      return base(call);
    });
    assertErrorResult(value, GMAIL_AUTH_FAILED, "auth_failed");
    assertRequestsAroundFatal(world, order, position, gmailFullUrl);
    if (position === 0) {
      // The first message is the one that says whether the token works at
      // all. When it does not, nothing else is asked for.
      assertEquals(requestSequence(world), [gmailFullUrl(order[0])]);
    }
  }
});

Deno.test("email_read_batch (gmail): two messages answering 401 give the same single result", async () => {
  const order = ids("g", 8);
  const store: Record<string, Stored<FakeGmailMessage>> = {};
  order.forEach((id) => store[id] = gmailStored(id, `Body of ${id}`));
  const base = gmailReadHandler(store);
  const { value, world } = await readGmail(store, { message_ids: order }, (call) => {
    const id = messageIdOf(call);
    if (id === "g03" || id === "g06") return json({ error: { message: "Invalid Credentials" } }, 401);
    return base(call);
  });
  assertErrorResult(value, GMAIL_AUTH_FAILED, "auth_failed");
  assertRequestsAroundFatal(world, order, 2, gmailFullUrl);
});

Deno.test("email_read_batch (gmail): an expired token is refreshed before each read, and each refresh is persisted", async () => {
  const order = ids("g", 6);
  const store: Record<string, Stored<FakeGmailMessage>> = {};
  order.forEach((id) => store[id] = gmailStored(id, `Body of ${id}`));
  const base = gmailReadHandler(store);
  let minted = 0;
  const { value, world } = await readGmail(
    store,
    { message_ids: order },
    (call) => {
      if (call.host === "oauth2.googleapis.com") {
        return json({ access_token: `refreshed-gmail-token-${++minted}`, expires_in: 3600 });
      }
      if (call.bearer === ACCESS_TOKEN) return json({ error: { message: "Invalid Credentials" } }, 401);
      return base(call);
    },
    { oauth_token_expires_at: alreadyExpired() },
  );
  assertJsonResult(value, expectedGmailBatch(order, store));
  assertEquals(
    requestMultiset(world),
    [...order.map(gmailFullUrl), ...order.map(() => "POST https://oauth2.googleapis.com/token")].sort(),
  );
  assertEquals(world.db.filter((d) => d.method === "PATCH").length, order.length);
});

Deno.test("email_read_batch (gmail): a revoked refresh token stops the call at the first message, with one refresh and one status write", async () => {
  const order = ids("g", 6);
  const { value, world } = await readGmail(
    {},
    { message_ids: order },
    (call) => {
      if (call.host === "oauth2.googleapis.com") return json({ error: "invalid_grant" }, 400);
      return json({ error: { message: "unexpected" } }, 418);
    },
    { oauth_token_expires_at: alreadyExpired() },
  );
  assertErrorResult(value, GMAIL_AUTH_FAILED, "auth_failed");
  assertEquals(requestSequence(world), ["POST https://oauth2.googleapis.com/token"]);
  const writes = world.db.filter((d) => d.method === "PATCH");
  assertEquals(writes.length, 1);
  assertEquals((writes[0].body as { status: string }).status, "error");
});

Deno.test("email_read_batch (gmail): include_attachments spends one attachment budget across the batch, in order", async () => {
  // Six files of 1.9 MB against the 10 MiB batch budget: each is under the
  // 2 MiB per-file ceiling, so the reader hands over its bytes, and the batch
  // then charges them in order. Five fit (9.5 MB); the sixth is listed without
  // its bytes. The declared size is what is charged, which is what Gmail
  // reports; the invented payload itself is a few bytes.
  const SIZE = 1_900_000;
  const inline = "aW52ZW50ZWQgYXR0YWNobWVudCBieXRlcw";
  const order = ids("g", 6);
  const store: Record<string, Stored<FakeGmailMessage>> = {};
  for (const id of order) {
    store[id] = {
      message: {
        id,
        from: "files@mail.example",
        to: "owner@gmail-harness.example",
        subject: `Files ${id}`,
        text: "See attached.",
        internalDate: "1767225600000",
        attachments: [{ filename: `${id}.bin`, mimeType: "application/octet-stream", size: SIZE, data: inline }],
      },
    };
  }
  const { value, world } = await readGmail(store, { message_ids: order, include_attachments: true });
  const messages = value.result.structuredContent!.messages as { id: string; attachments: unknown[] }[];
  assertEquals(messages.map((m) => m.id), order);
  assertEquals(
    messages.map((m) => m.attachments),
    order.map((id, i) => [{
      filename: `${id}.bin`,
      mime_type: "application/octet-stream",
      size_bytes: SIZE,
      data: i < 5 ? `${inline}==` : null,
      attachment_index: 0,
    }]),
  );
  assertEquals(value.result.content[0].text, JSON.stringify(value.result.structuredContent));
  assertEquals(value.result.structuredContent!.errors, []);
  assertEquals(requestMultiset(world), order.map(gmailFullUrl).sort());
});

// ═══════════════════════════════════════════════════════════════════════════
// email_read_batch — Outlook
// ═══════════════════════════════════════════════════════════════════════════

function graphStored(id: string, content: string): Stored<FakeGraphMessage> {
  return {
    message: {
      id,
      subject: `Subject ${id}`,
      from: { name: `Sender ${id}`, address: `sender-${id}@mail.example` },
      to: [{ name: "Owner", address: "owner@outlook-harness.example" }],
      contentType: "text",
      content,
      isRead: false,
    },
  };
}

function graphFailure(kind: string): Response {
  switch (kind) {
    case "500":
      return json({ error: { code: "InternalServerError", message: "Something broke." } }, 500);
    case "404":
      return json({ error: { code: "ErrorItemNotFound", message: "The specified object was not found in the store." } }, 404);
    case "403":
      return json({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }, 403);
    case "429":
      // No Retry-After a retry may honour: the ask is longer than the policy's
      // single-wait ceiling, so the 429 is returned as it is.
      return json({ error: { code: "TooManyRequests", message: "Slow down." } }, 429, { "retry-after": "60" });
  }
  throw new TypeError("connection reset");
}

const GRAPH_ERROR_TEXT: Record<string, string> = {
  "500": "Provider error: Outlook read message error 500 (InternalServerError): Something broke.",
  "404": NOT_FOUND_ENTRY,
  "403":
    "Provider error: Outlook read message error 403 (ErrorAccessDenied): Microsoft refused this request for lack of permission: " +
    "Access is denied. This is a mailbox permission or organisation policy, not an expired sign-in, so reconnecting the inbox will not change it.",
  "429": "Provider error: Outlook read message error 429 (TooManyRequests): Slow down.",
  "reject": "Provider error: connection reset",
};

function graphReadHandler(store: Record<string, Stored<FakeGraphMessage>>): ProviderHandler {
  return (call) => {
    const id = messageIdOf(call);
    const entry = store[id];
    if (!entry) return graphFailure("404");
    if ("fail" in entry) return graphFailure(entry.fail);
    return json(graphMessage(entry.message));
  };
}

function expectedGraphBatch(
  order: string[],
  store: Record<string, Stored<FakeGraphMessage>>,
  cap = 2_000,
): Record<string, unknown> {
  const windows = serialWindows(
    order.map((id) => {
      const entry = store[id];
      if (!entry || "fail" in entry) return { id, text: null, html: null, errored: true };
      return { id, text: entry.message.content ?? "", html: null, errored: false };
    }),
    cap,
  );
  const messages: Record<string, unknown>[] = [];
  const errors: { message_id: string; error: string }[] = [];
  order.forEach((id, i) => {
    const entry = store[id];
    if (!entry || "fail" in entry) {
      errors.push({ message_id: id, error: GRAPH_ERROR_TEXT[entry ? entry.fail : "404"] });
      return;
    }
    const w = windows[i]!;
    messages.push({
      id,
      thread_id: `conv-${id}`,
      from: { name: `Sender ${id}`, email: `sender-${id}@mail.example` },
      to: [{ name: "Owner", email: "owner@outlook-harness.example" }],
      cc: [],
      bcc: [],
      reply_to: null,
      subject: `Subject ${id}`,
      date: "2026-01-01T00:00:00Z",
      body_text: w.body_text,
      body_html: null,
      attachments: [],
      is_read: false,
      labels: [],
      in_reply_to: null,
      references: [],
      ...(w.textFields as Record<string, unknown>),
    });
  });
  return { messages, errors, untrusted_content: true };
}

const MS_TOKEN_URL = "POST https://login.microsoftonline.com/common/oauth2/v2.0/token";

async function readOutlook(
  args: Record<string, unknown>,
  handler: ProviderHandler,
  inboxOverrides: Record<string, unknown> = {},
) {
  const inbox = await inboxRow("outlook", inboxOverrides);
  return await runTool(
    inbox,
    handler,
    () => executeReadEmails({ inbox_id: INBOX_ID, ...args }, API_KEY) as Promise<ToolOutcome>,
  );
}

Deno.test("email_read_batch (outlook): ordinary messages, an HTML body, and an attachment listing", async () => {
  const handler: ProviderHandler = (call) => {
    if (call.url.includes("/attachments?")) {
      return json({
        value: [{ id: "att-1", name: "minutes.pdf", contentType: "application/pdf", size: 48213, isInline: false }],
      });
    }
    const id = messageIdOf(call);
    if (id === "oa") {
      return json(graphMessage({
        id: "oa",
        subject: "Minutes from Monday",
        from: { name: "Kari Nordmann", address: "kari@kontor.example" },
        to: [{ name: "Owner", address: "owner@outlook-harness.example" }],
        contentType: "html",
        content: "<p>Hello <b>there</b>,</p><p>Minutes attached.</p>",
        hasAttachments: true,
        isRead: true,
        receivedDateTime: "2026-02-03T09:15:00Z",
      }));
    }
    return json(graphMessage({
      id: "ob",
      subject: "Lunch?",
      from: { name: "", address: "ola@kontor.example" },
      to: [],
      contentType: "text",
      content: "Tomorrow at twelve?",
      isRead: false,
      receivedDateTime: "2026-02-04T11:00:00Z",
    }));
  };
  const { value, world } = await readOutlook({ message_ids: ["oa", "ob"] }, handler);
  assertJsonResult(value, {
    messages: [
      {
        id: "oa",
        thread_id: "conv-oa",
        from: { name: "Kari Nordmann", email: "kari@kontor.example" },
        to: [{ name: "Owner", email: "owner@outlook-harness.example" }],
        cc: [],
        bcc: [],
        reply_to: null,
        subject: "Minutes from Monday",
        date: "2026-02-03T09:15:00Z",
        body_text: "Hello there,\n\nMinutes attached.",
        body_html: null,
        attachments: [{
          filename: "minutes.pdf",
          mime_type: "application/pdf",
          size_bytes: 48213,
          data: null,
          attachment_index: 0,
        }],
        is_read: true,
        labels: [],
        in_reply_to: null,
        references: [],
      },
      {
        id: "ob",
        thread_id: "conv-ob",
        from: { name: "", email: "ola@kontor.example" },
        to: [],
        cc: [],
        bcc: [],
        reply_to: null,
        subject: "Lunch?",
        date: "2026-02-04T11:00:00Z",
        body_text: "Tomorrow at twelve?",
        body_html: null,
        attachments: [],
        is_read: false,
        labels: [],
        in_reply_to: null,
        references: [],
      },
    ],
    errors: [],
    untrusted_content: true,
  });
  assertEquals(
    requestMultiset(world),
    [
      graphReadUrl("oa"),
      `GET ${GRAPH}/me/messages/oa/attachments?$select=id,name,contentType,size,isInline`,
      graphReadUrl("ob"),
    ].sort(),
  );
  for (const call of world.calls) {
    assertEquals(call.bearer, ACCESS_TOKEN);
    assertEquals(call.headers["prefer"], 'IdType="ImmutableId"');
  }
});

Deno.test("email_read_batch (outlook): the maximum batch, and bodies that exhaust the budget part-way", async () => {
  const order = ids("o", 50);
  const store: Record<string, Stored<FakeGraphMessage>> = {};
  order.forEach((id, i) => {
    if (i === 10) store[id] = { fail: "404" };
    else store[id] = graphStored(id, String.fromCharCode(65 + (i % 26)).repeat(i % 6 === 0 ? 30 : 900 + 37 * i));
  });
  const { value, world } = await readOutlook({ message_ids: order }, graphReadHandler(store));
  assertJsonResult(value, expectedGraphBatch(order, store));
  const messages = value.result.structuredContent!.messages as { id: string; body_text: string }[];
  assertEquals(messages.length, 49);
  assertEquals(
    messages.map((m) => m.body_text.length),
    [
      30, 489, 489, 489, 489, 489, 30, 499, 499, 499, 512, 30, 525, 525, 525, 525, 525, 30, 541, 542, 542, 542, 542,
      30, 562, 562, 562, 562, 562, 30, 590, 590, 590, 590, 590, 30, 634, 634, 634, 634, 634, 30, 720, 720, 720, 720,
      720, 30, 1412,
    ],
  );
  assertEquals(requestMultiset(world), order.map(graphReadUrl).sort());
});

Deno.test("email_read_batch (outlook): one failing message becomes one error entry, in place, for every kind and position", async () => {
  const order = ids("o", 6);
  for (const kind of ["500", "404", "403", "429", "reject"] as const) {
    for (const position of [0, 2, 5]) {
      const store: Record<string, Stored<FakeGraphMessage>> = {};
      order.forEach((id, i) => store[id] = i === position ? { fail: kind } : graphStored(id, `Body of ${id}`));
      const { value, world } = await readOutlook({ message_ids: order }, graphReadHandler(store));
      assertJsonResult(value, expectedGraphBatch(order, store));
      assertEquals(value.result.structuredContent!.errors, [
        { message_id: order[position], error: GRAPH_ERROR_TEXT[kind] },
      ]);
      assertEquals(requestMultiset(world), order.map(graphReadUrl).sort(), `${kind} at ${position}`);
      assertEquals(world.graphSleeps, [], "a Retry-After over the ceiling is not waited for");
    }
  }
});

Deno.test("email_read_batch (outlook): a 429 with a short Retry-After is retried and the message is read", async () => {
  const order = ids("o", 6);
  for (const position of [0, 3, 5]) {
    const store: Record<string, Stored<FakeGraphMessage>> = {};
    order.forEach((id) => store[id] = graphStored(id, `Body of ${id}`));
    const base = graphReadHandler(store);
    let throttled = 0;
    const { value, world } = await readOutlook({ message_ids: order }, (call) => {
      if (messageIdOf(call) === order[position] && throttled++ < 1) {
        return json({ error: { code: "TooManyRequests", message: "Slow down." } }, 429, { "retry-after": "2" });
      }
      return base(call);
    });
    assertJsonResult(value, expectedGraphBatch(order, store));
    assertEquals(requestMultiset(world), [...order.map(graphReadUrl), graphReadUrl(order[position])].sort());
    assertEquals(world.graphSleeps, [2000]);
  }
});

Deno.test("email_read_batch (outlook): a 429 that never clears is retried twice, then reported for that message only", async () => {
  const order = ids("o", 5);
  const store: Record<string, Stored<FakeGraphMessage>> = {};
  order.forEach((id) => store[id] = graphStored(id, `Body of ${id}`));
  const base = graphReadHandler(store);
  const { value, world } = await readOutlook({ message_ids: order }, (call) => {
    if (messageIdOf(call) === "o03") return json({ error: { code: "TooManyRequests", message: "Slow down." } }, 429);
    return base(call);
  });
  const expected = expectedGraphBatch(order, { ...store, o03: { fail: "429" } });
  assertJsonResult(value, expected);
  assertEquals(
    requestMultiset(world),
    [...order.map(graphReadUrl), graphReadUrl("o03"), graphReadUrl("o03")].sort(),
  );
  assertEquals(world.graphSleeps, [1000, 2000]);
});

Deno.test("email_read_batch (outlook): a 401 on one message refreshes the token once, retries it, and the batch completes", async () => {
  const order = ids("o", 7);
  for (const position of [0, 3, 6]) {
    const store: Record<string, Stored<FakeGraphMessage>> = {};
    order.forEach((id) => store[id] = graphStored(id, `Body of ${id}`));
    const base = graphReadHandler(store);
    const { value, world } = await readOutlook({ message_ids: order }, (call) => {
      if (call.host === "login.microsoftonline.com") {
        return json({ access_token: "refreshed-graph-token", refresh_token: "rotated-refresh", expires_in: 3600 });
      }
      if (messageIdOf(call) === order[position] && call.bearer === ACCESS_TOKEN) {
        return new Response(null, { status: 401 });
      }
      return base(call);
    });
    assertJsonResult(value, expectedGraphBatch(order, store));
    assertEquals(
      requestMultiset(world),
      [...order.map(graphReadUrl), graphReadUrl(order[position]), MS_TOKEN_URL].sort(),
      `401 at ${position}`,
    );
    // The retry of the refused message carries the new token.
    const attempts = world.calls.filter((c) => c.url.includes(`/me/messages/${order[position]}?`));
    assertEquals(attempts.map((c) => c.bearer), [ACCESS_TOKEN, "refreshed-graph-token"]);
    assertEquals(world.db.filter((d) => d.method === "PATCH").length, 1, "the rotated token is persisted once");
  }
});

Deno.test("email_read_batch (outlook): a token Graph refuses outright costs one refused request, one refresh, then every read on the new token", async () => {
  const order = ids("o", 9);
  const store: Record<string, Stored<FakeGraphMessage>> = {};
  order.forEach((id) => store[id] = graphStored(id, `Body of ${id}`));
  const base = graphReadHandler(store);
  const { value, world } = await readOutlook({ message_ids: order }, (call) => {
    if (call.host === "login.microsoftonline.com") {
      return json({ access_token: "refreshed-graph-token", refresh_token: "rotated-refresh", expires_in: 3600 });
    }
    if (call.bearer === ACCESS_TOKEN) return new Response(null, { status: 401 });
    return base(call);
  });
  assertJsonResult(value, expectedGraphBatch(order, store));
  assertEquals(
    world.calls.map((c) => `${c.method} ${c.url} as ${c.bearer ?? "-"}`).sort(),
    [
      `${graphReadUrl("o01")} as ${ACCESS_TOKEN}`,
      `${MS_TOKEN_URL} as -`,
      ...order.map((id) => `${graphReadUrl(id)} as refreshed-graph-token`),
    ].sort(),
  );
});

Deno.test("email_read_batch (outlook): an expired token is refreshed once for the whole batch", async () => {
  const order = ids("o", 9);
  const store: Record<string, Stored<FakeGraphMessage>> = {};
  order.forEach((id) => store[id] = graphStored(id, `Body of ${id}`));
  const base = graphReadHandler(store);
  const { value, world } = await readOutlook(
    { message_ids: order },
    (call) => {
      if (call.host === "login.microsoftonline.com") {
        return json({ access_token: "refreshed-graph-token", refresh_token: "rotated-refresh", expires_in: 3600 });
      }
      if (call.bearer === ACCESS_TOKEN) return new Response(null, { status: 401 });
      return base(call);
    },
    { oauth_token_expires_at: alreadyExpired() },
  );
  assertJsonResult(value, expectedGraphBatch(order, store));
  assertEquals(requestMultiset(world), [MS_TOKEN_URL, ...order.map(graphReadUrl)].sort());
  assertEquals(requestSequence(world)[0], MS_TOKEN_URL);
  assertEquals(world.db.filter((d) => d.method === "PATCH").length, 1);
});

Deno.test("email_read_batch (outlook): a revoked refresh token is fatal: reconnect, one refresh attempt, one status write", async () => {
  const order = ids("o", 9);
  const store: Record<string, Stored<FakeGraphMessage>> = {};
  order.forEach((id) => store[id] = graphStored(id, `Body of ${id}`));
  const base = graphReadHandler(store);
  for (const position of [0, 4]) {
    const { value, world } = await readOutlook({ message_ids: order }, (call) => {
      if (call.host === "login.microsoftonline.com") return json({ error: "invalid_grant" }, 400);
      if (messageIdOf(call) === order[position]) return new Response(null, { status: 401 });
      return base(call);
    });
    assertErrorResult(value, OUTLOOK_AUTH_FAILED, "auth_failed");
    assertRequestsAroundFatal(world, order, position, graphReadUrl);
    if (position === 0) {
      assertEquals(requestSequence(world), [graphReadUrl("o01"), MS_TOKEN_URL]);
      const writes = world.db.filter((d) => d.method === "PATCH");
      assertEquals(writes.length, 1);
      assertEquals((writes[0].body as { status: string }).status, "error");
    }
  }
});

Deno.test("email_read_batch (outlook): an account with no mailbox reports it per message and is never told to reconnect", async () => {
  // A token minted by a refresh in this very request and still refused: the
  // Graph layer reads that as "no mailbox", not "reconnect".
  const order = ids("o", 6);
  const { value, world } = await readOutlook(
    { message_ids: order },
    (call) => {
      if (call.host === "login.microsoftonline.com") {
        return json({ access_token: "refreshed-graph-token", refresh_token: "rotated-refresh", expires_in: 3600 });
      }
      return new Response(null, { status: 401 });
    },
    { oauth_token_expires_at: alreadyExpired() },
  );
  const NO_MAILBOX = "Provider error: This Microsoft account has no Outlook / Exchange Online mailbox that Microsoft Graph can reach. " +
    "Microsoft accepted the sign-in, but there is no mailbox behind it: typically an administrator " +
    "account without an Exchange Online licence, or an organisation whose mail is hosted somewhere " +
    "else. Reconnecting will not change this. If the address's mail is hosted on another server, " +
    "remove this inbox and connect the address with IMAP instead.";
  assertJsonResult(value, {
    messages: [],
    errors: order.map((message_id) => ({ message_id, error: NO_MAILBOX })),
    untrusted_content: true,
  });
  // The first message is refused on a token minted this very request. Every
  // later one finds a stored token that looks current, is refused, forces one
  // more refresh, and is refused again: two requests and one refresh each.
  assertEquals(
    requestMultiset(world),
    [
      ...order.map(() => MS_TOKEN_URL),
      graphReadUrl(order[0]),
      ...order.slice(1).flatMap((id) => [graphReadUrl(id), graphReadUrl(id)]),
    ].sort(),
  );
  const writes = world.db.filter((d) => d.method === "PATCH").map((d) => d.body as Record<string, unknown>);
  assertEquals(writes.filter((w) => w.status === "error").length, order.length, "marked no-mailbox once per message");
  assertEquals(writes.filter((w) => "oauth_access_token" in w).length, order.length, "each refresh persisted");
});

Deno.test("email_read_batch (gmail): until one message has been read, a fatal failure stops exactly where it struck", async () => {
  // Two stale ids, then a 401. Nothing has been read successfully, so nothing
  // beyond the failing message may have been asked for.
  const order = ids("g", 9);
  const store: Record<string, Stored<FakeGmailMessage>> = {};
  order.forEach((id, i) => store[id] = i < 2 ? { fail: i === 0 ? "404" : "500" } : gmailStored(id, `Body of ${id}`));
  const base = gmailReadHandler(store);
  const { value, world } = await readGmail(store, { message_ids: order }, (call) => {
    if (messageIdOf(call) === "g03") return json({ error: { message: "Invalid Credentials" } }, 401);
    return base(call);
  });
  assertErrorResult(value, GMAIL_AUTH_FAILED, "auth_failed");
  assertEquals(requestSequence(world), ["g01", "g02", "g03"].map(gmailFullUrl));
});

Deno.test("email_read_batch (gmail): a batch of stale ids is read one id at a time", async () => {
  const order = ids("g", 7);
  const store: Record<string, Stored<FakeGmailMessage>> = {};
  order.forEach((id) => store[id] = { fail: "404" });
  const { world } = await readGmail(store, { message_ids: order });
  assertEquals(requestSequence(world), order.map(gmailFullUrl));
});

/**
 * Run a batch read with the wall clock under the test's control: `Date.now`
 * jumps ten minutes, past the 25 second budget, the moment the provider is
 * asked for `jumpAt`.
 */
async function readWithClockJump(
  provider: "gmail" | "outlook",
  order: string[],
  jumpAt: string,
  serve: ProviderHandler,
) {
  const inbox = await inboxRow(provider);
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try {
    return await runTool(
      inbox,
      (call) => {
        if (messageIdOf(call) === jumpAt) skew = 600_000;
        return serve(call);
      },
      () => executeReadEmails({ inbox_id: INBOX_ID, message_ids: order }, API_KEY) as Promise<ToolOutcome>,
    );
  } finally {
    Date.now = realNow;
  }
}

Deno.test("email_read_batch: when the time budget runs out, the ids not reached are reported and nothing after them is returned", async () => {
  for (const provider of ["gmail", "outlook"] as const) {
    const order = ids(provider === "gmail" ? "g" : "o", 12);
    const url = provider === "gmail" ? gmailFullUrl : graphReadUrl;
    for (const position of [0, 5, 10]) {
      const gmailStore: Record<string, Stored<FakeGmailMessage>> = {};
      const graphStore: Record<string, Stored<FakeGraphMessage>> = {};
      order.forEach((id, i) => {
        // One ordinary failure before the stop, so `failed` is counted too.
        if (i === 2) {
          gmailStore[id] = { fail: "404" };
          graphStore[id] = { fail: "404" };
        } else {
          gmailStore[id] = gmailStored(id, `Body of ${id}`);
          graphStore[id] = graphStored(id, `Body of ${id}`);
        }
      });
      const { value, world } = await readWithClockJump(
        provider,
        order,
        order[position],
        provider === "gmail" ? gmailReadHandler(gmailStore) : graphReadHandler(graphStore),
      );
      // The message being read when the clock jumped is returned; the ones
      // after it are the remainder.
      const reached = order.slice(0, position + 1);
      const remaining = order.slice(position + 1);
      const body = provider === "gmail"
        ? expectedGmailBatch(order, gmailStore)
        : expectedGraphBatch(order, graphStore);
      // The windows were sized for a batch of twelve, so the expectation is
      // the full batch's, cut down to the messages that were reached.
      const messages = (body.messages as { id: string }[]).filter((m) => reached.includes(m.id));
      const errors = (body.errors as { message_id: string }[]).filter((e) => reached.includes(e.message_id));
      const expected = {
        ...bulkPartialFields({
          operation: "email_read_batch",
          total: order.length,
          succeeded: messages.length,
          failed: errors.length,
          remainingIds: remaining,
          reason: "time_budget",
          budgetMs: 25_000,
        }),
        messages,
        errors,
        untrusted_content: true,
      };
      assertJsonResult(value, expected);
      const structured = value.result.structuredContent!;
      assertEquals(structured.partial, true);
      assertEquals(structured.stopped_reason, "time_budget");
      assertEquals(structured.total_requested, 12);
      assertEquals(structured.remaining_message_ids, remaining);
      assertEquals((structured.messages as { id: string }[]).map((m) => m.id), reached.filter((id) => id !== order[2]));
      assertRequestsAroundFatal(world, order, position, url);
      if (position === 0) assertEquals(requestSequence(world), [url(order[0])]);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// email_list — Gmail
// ═══════════════════════════════════════════════════════════════════════════

interface ListScenario {
  /** Ids messages.list returns for the page. */
  refs: string[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
  /** What labels.get answers; a Response, or a thrown error. */
  label?: () => Response;
  /** Ids whose messages.get fails, and how. */
  metaFail?: Record<string, "404" | "429" | "reject" | "not_json">;
  listStatus?: number;
}

function listHandler(s: ListScenario): ProviderHandler {
  return (call: ProviderCall) => {
    if (call.url.includes("/messages?")) {
      if (s.listStatus) return json({ error: { message: s.listStatus === 401 ? "Invalid Credentials" : "Backend Error" } }, s.listStatus);
      return json({
        ...(s.refs.length ? { messages: s.refs.map((id) => ({ id, threadId: `t-${id}` })) } : {}),
        ...(s.nextPageToken ? { nextPageToken: s.nextPageToken } : {}),
        resultSizeEstimate: s.resultSizeEstimate ?? s.refs.length,
      });
    }
    if (call.url.includes("/labels/")) {
      if (!s.label) return json({ error: { message: "unexpected labels.get" } }, 418);
      return s.label();
    }
    const id = messageIdOf(call);
    switch (s.metaFail?.[id]) {
      case "404":
        return json({ error: { code: 404, message: "Requested entity was not found." } }, 404);
      case "429":
        return json({ error: { code: 429, message: "Too many concurrent requests for user" } }, 429);
      case "reject":
        throw new TypeError("connection reset");
      case "not_json":
        return new Response("<html>gateway</html>", { status: 502 });
    }
    return json(gmailMeta({
      id,
      threadId: `thread-${id}`,
      from: `Sender ${id} <sender-${id}@mail.example>`,
      to: "owner@gmail-harness.example",
      subject: `Subject ${id}`,
      snippet: `Preview   of ${id}`,
      labelIds: id.endsWith("1") ? ["INBOX", "UNREAD"] : ["INBOX"],
      internalDate: "1767225600000",
    }));
  };
}

function expectedRow(id: string, folder = "INBOX"): Record<string, unknown> {
  return {
    id,
    from: { name: `Sender ${id}`, email: `sender-${id}@mail.example` },
    to: [{ name: "", email: "owner@gmail-harness.example" }],
    subject: `Subject ${id}`,
    date: "2026-01-01T00:00:00.000Z",
    preview: `Preview of ${id}`,
    is_read: !id.endsWith("1"),
    has_attachments: false,
    folder,
    thread_id: `thread-${id}`,
  };
}

const listUrl = (query: string) => `GET ${GMAIL}/messages?${query}`;
const LABEL_URL = `GET ${GMAIL}/labels/INBOX`;

async function listInbox(s: ListScenario, args: Record<string, unknown> = {}) {
  const inbox = await inboxRow("gmail");
  return await runTool(
    inbox,
    listHandler(s),
    () => executeListInbox({ inbox_id: INBOX_ID, ...args }, API_KEY) as Promise<ToolOutcome>,
  );
}

Deno.test("email_list (gmail): a page of a larger label takes its exact total from labels.get", async () => {
  const refs = ids("l", 3);
  const { value, world } = await listInbox({
    refs,
    nextPageToken: "page-2",
    resultSizeEstimate: 201,
    label: () => json({ id: "INBOX", messagesTotal: 57, messagesUnread: 4 }),
  }, { limit: 3 });
  assertJsonResult(value, {
    messages: [
      {
        id: "l01",
        from: { name: "Sender l01", email: "sender-l01@mail.example" },
        to: [{ name: "", email: "owner@gmail-harness.example" }],
        subject: "Subject l01",
        date: "2026-01-01T00:00:00.000Z",
        preview: "Preview of l01",
        is_read: false,
        has_attachments: false,
        folder: "INBOX",
        thread_id: "thread-l01",
      },
      expectedRow("l02"),
      expectedRow("l03"),
    ],
    total: 57,
    total_is_estimate: false,
    has_more: true,
    next_offset: 3,
    untrusted_content: true,
  });
  assertEquals(
    requestMultiset(world),
    [listUrl("labelIds=INBOX&maxResults=3"), LABEL_URL, ...refs.map(listMetaUrl)].sort(),
  );
  // The listing comes first: the label and the rows are only known after it.
  assertEquals(requestSequence(world)[0], listUrl("labelIds=INBOX&maxResults=3"));
  for (const call of world.calls) assertEquals(call.bearer, ACCESS_TOKEN);
});

Deno.test("email_list (gmail): a label that fits in the page is counted from the page, with no labels.get", async () => {
  const refs = ids("l", 4);
  const { value, world } = await listInbox({ refs, resultSizeEstimate: 9 });
  assertJsonResult(value, {
    messages: refs.map((id) => expectedRow(id)),
    total: 4,
    total_is_estimate: false,
    has_more: false,
    next_offset: null,
    untrusted_content: true,
  });
  assertEquals(requestMultiset(world), [listUrl("labelIds=INBOX&maxResults=20"), ...refs.map(listMetaUrl)].sort());
});

Deno.test("email_list (gmail): an empty label makes one request", async () => {
  const { value, world } = await listInbox({ refs: [], resultSizeEstimate: 0 });
  assertJsonResult(value, {
    messages: [],
    total: 0,
    total_is_estimate: false,
    has_more: false,
    next_offset: null,
    untrusted_content: true,
  });
  assertEquals(requestSequence(world), [listUrl("labelIds=INBOX&maxResults=20")]);
});

Deno.test("email_list (gmail): the maximum page is 100 rows, in listing order, one get each", async () => {
  const refs = ids("l", 100);
  const { value, world } = await listInbox({
    refs,
    nextPageToken: "page-2",
    resultSizeEstimate: 5000,
    label: () => json({ messagesTotal: 4321, messagesUnread: 12 }),
  }, { limit: 100 });
  assertJsonResult(value, {
    messages: refs.map((id) => expectedRow(id)),
    total: 4321,
    total_is_estimate: false,
    has_more: true,
    next_offset: 100,
    untrusted_content: true,
  });
  assertEquals(
    requestMultiset(world),
    [listUrl("labelIds=INBOX&maxResults=100"), LABEL_URL, ...refs.map(listMetaUrl)].sort(),
  );
});

Deno.test("email_list (gmail): the unread filter picks the matching label counter", async () => {
  const refs = ids("l", 2);
  const label = () => json({ messagesTotal: 57, messagesUnread: 4 });
  const cases: [Record<string, unknown>, string, number][] = [
    [{ unread: true }, "labelIds=INBOX&maxResults=2&q=is%3Aunread", 4],
    [{ unread: false }, "labelIds=INBOX&maxResults=2&q=is%3Aread", 53],
  ];
  for (const [args, query, total] of cases) {
    const { value, world } = await listInbox({ refs, nextPageToken: "p", resultSizeEstimate: 99, label }, { limit: 2, ...args });
    assertJsonResult(value, {
      messages: refs.map((id) => expectedRow(id)),
      total,
      total_is_estimate: false,
      has_more: true,
      next_offset: 2,
      untrusted_content: true,
    });
    assertEquals(requestMultiset(world), [listUrl(query), LABEL_URL, ...refs.map(listMetaUrl)].sort());
  }
});

Deno.test("email_list (gmail): labels.get failing, or lying, falls back to the estimate and the rows are unaffected", async () => {
  const refs = ids("l", 3);
  const failures: [string, () => Response][] = [
    ["500", () => json({ error: { message: "Backend Error" } }, 500)],
    ["401", () => json({ error: { message: "Invalid Credentials" } }, 401)],
    ["429", () => json({ error: { message: "Too many concurrent requests for user" } }, 429)],
    ["network", () => {
      throw new TypeError("connection reset");
    }],
    ["not json", () => new Response("<html>gateway</html>", { status: 200 })],
    ["no counters", () => json({ id: "INBOX" })],
    ["a counter below the rows in hand", () => json({ messagesTotal: 2, messagesUnread: 0 })],
  ];
  for (const [name, label] of failures) {
    const { value, world } = await listInbox({ refs, nextPageToken: "p", resultSizeEstimate: 201, label }, { limit: 3 });
    assertJsonResult(value, {
      messages: refs.map((id) => expectedRow(id)),
      total: 201,
      total_is_estimate: true,
      has_more: true,
      next_offset: 3,
      untrusted_content: true,
    });
    assertEquals(
      requestMultiset(world),
      [listUrl("labelIds=INBOX&maxResults=3"), LABEL_URL, ...refs.map(listMetaUrl)].sort(),
      name,
    );
  }
});

Deno.test("email_list (gmail): a row whose get answers an error body is listed with defaults; the total is still exact", async () => {
  const refs = ids("l", 4);
  for (const kind of ["404", "429"] as const) {
    const { value, world } = await listInbox({
      refs,
      nextPageToken: "p",
      resultSizeEstimate: 201,
      label: () => json({ messagesTotal: 57, messagesUnread: 4 }),
      metaFail: { l02: kind },
    }, { limit: 4 });
    const structured = value.result.structuredContent as {
      messages: Record<string, unknown>[];
      total: number;
      total_is_estimate: boolean;
    };
    // The defaulted row carries the time of the call, so it is checked field
    // by field instead of as a literal.
    const { date, ...defaulted } = structured.messages[1];
    assertEquals(defaulted, {
      id: "l02",
      from: { name: "", email: "" },
      to: [],
      subject: "(no subject)",
      preview: "",
      is_read: true,
      has_attachments: false,
      folder: "INBOX",
      thread_id: "t-l02",
    });
    assert(typeof date === "string" && !Number.isNaN(Date.parse(date)));
    assertEquals([structured.messages[0], structured.messages[2], structured.messages[3]], [
      expectedRow("l01"),
      expectedRow("l03"),
      expectedRow("l04"),
    ]);
    assertEquals([structured.total, structured.total_is_estimate], [57, false]);
    assertEquals(value.result.content[0].text, JSON.stringify(structured));
    assertEquals(
      requestMultiset(world),
      [listUrl("labelIds=INBOX&maxResults=4"), LABEL_URL, ...refs.map(listMetaUrl)].sort(),
    );
  }
});

Deno.test("email_list (gmail): a row whose get cannot be read at all fails the listing, after labels.get was asked", async () => {
  const refs = ids("l", 4);
  const cases: ["reject" | "not_json", string][] = [
    ["reject", "Provider error while listing inbox: connection reset. Please try again in a moment."],
  ];
  for (const [kind, text] of cases) {
    for (const failing of ["l01", "l03", "l04"]) {
      const { value, world } = await listInbox({
        refs,
        nextPageToken: "p",
        resultSizeEstimate: 201,
        label: () => json({ messagesTotal: 57, messagesUnread: 4 }),
        metaFail: { [failing]: kind },
      }, { limit: 4 });
      assertErrorResult(value, text, "provider_error");
      assertEquals(
        requestMultiset(world),
        [listUrl("labelIds=INBOX&maxResults=4"), LABEL_URL, ...refs.map(listMetaUrl)].sort(),
      );
    }
  }
  // A body that is not JSON is the same class of failure.
  const notJson = await listInbox({
    refs,
    nextPageToken: "p",
    label: () => json({ messagesTotal: 57, messagesUnread: 4 }),
    metaFail: { l02: "not_json" },
  }, { limit: 4 });
  assertEquals(notJson.value.result.isError, true);
  assertEquals(notJson.value.logErrorCode, "provider_error");
  assert(notJson.value.result.content[0].text.startsWith("Provider error while listing inbox: "));
});

Deno.test("email_list (gmail): both labels.get and a row failing is the row's failure", async () => {
  const refs = ids("l", 3);
  const { value, world } = await listInbox({
    refs,
    nextPageToken: "p",
    resultSizeEstimate: 201,
    label: () => json({ error: { message: "Backend Error" } }, 500),
    metaFail: { l02: "reject" },
  }, { limit: 3 });
  assertErrorResult(
    value,
    "Provider error while listing inbox: connection reset. Please try again in a moment.",
    "provider_error",
  );
  assertEquals(
    requestMultiset(world),
    [listUrl("labelIds=INBOX&maxResults=3"), LABEL_URL, ...refs.map(listMetaUrl)].sort(),
  );
});

Deno.test("email_list (gmail): the listing's own failure is the call's failure, with nothing else asked", async () => {
  const cases: [number, string, string][] = [
    [401, GMAIL_AUTH_FAILED, "auth_failed"],
    [500, "Provider error while listing inbox: Gmail API error: Backend Error. Please try again in a moment.", "provider_error"],
    [429, "Provider error while listing inbox: Gmail API error: Backend Error. Please try again in a moment.", "provider_error"],
  ];
  for (const [listStatus, text, code] of cases) {
    const { value, world } = await listInbox({ refs: ids("l", 3), listStatus });
    assertErrorResult(value, text, code);
    assertEquals(requestSequence(world), [listUrl("labelIds=INBOX&maxResults=20")]);
  }
});

Deno.test("email_list (gmail): an offset past the first page pages forward, then asks labels.get once", async () => {
  // Gmail has no numeric offset: the tool walks nextPageToken until it holds
  // offset + limit refs, then slices.
  const inbox = await inboxRow("gmail");
  const pageOne = ids("p", 4);
  const pageTwo = ids("q", 2);
  const { value, world } = await runTool(
    inbox,
    (call) => {
      if (call.url.includes("/messages?")) {
        const second = call.url.includes("pageToken=");
        return json({
          messages: (second ? pageTwo : pageOne).map((id) => ({ id, threadId: `t-${id}` })),
          nextPageToken: second ? "page-3" : "page-2",
          resultSizeEstimate: 300,
        });
      }
      if (call.url.includes("/labels/")) return json({ messagesTotal: 88, messagesUnread: 1 });
      return listHandler({ refs: [] })(call);
    },
    () => executeListInbox({ inbox_id: INBOX_ID, limit: 2, offset: 4 }, API_KEY) as Promise<ToolOutcome>,
  );
  assertJsonResult(value, {
    messages: pageTwo.map((id) => expectedRow(id)),
    total: 88,
    total_is_estimate: false,
    has_more: true,
    next_offset: 6,
    untrusted_content: true,
  });
  assertEquals(
    requestMultiset(world),
    [
      listUrl("labelIds=INBOX&maxResults=6"),
      listUrl("labelIds=INBOX&maxResults=2&pageToken=page-2"),
      LABEL_URL,
      ...pageTwo.map(listMetaUrl),
    ].sort(),
  );
  // The two listing pages are a chain; labels.get and the rows follow them.
  assertEquals(requestSequence(world).slice(0, 2), [
    listUrl("labelIds=INBOX&maxResults=6"),
    listUrl("labelIds=INBOX&maxResults=2&pageToken=page-2"),
  ]);
});

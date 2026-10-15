// ---------------------------------------------------------------------------
// draft-attachments-flow.test.ts — files on a draft, end to end through the
// real draft handlers over the fake Gmail / Graph network
// (provider-call-harness.ts).
//
// What is pinned: which files each STORED message carries. On Gmail that is
// the MIME the drafts API is handed, decoded and parsed back; on Outlook it is
// the Graph requests. Above all, that an update keeps the files a draft
// already has: until 2026-10-15 a full-body update on Gmail and IMAP rebuilt
// the message without them and reported success.
//
// Every mailbox, address, file and byte here is invented.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  API_KEY,
  b64url,
  executeCreateDraft,
  executeCreateReplyDraft,
  executeUpdateDraft,
  graphMessage,
  inboxRow,
  json,
  type ProviderCall,
  runTool,
} from "./provider-call-harness.ts";
import { parseEmail } from "./mime.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const GRAPH = "https://graph.microsoft.com/v1.0";
/** A public IP literal, so the download guard needs no DNS. */
const FILE_HOST = "https://93.184.215.14";

const CHATGPT_KEY = { ...API_KEY, name: "OAuth: ChatGPT", scopes: [...API_KEY.scopes, "manage:drafts"] };

// deno-lint-ignore no-explicit-any
type Outcome = { result: any; logStatus: string; logErrorCode: string | null };

const PDF = { filename: "Angebot.pdf", mime_type: "application/pdf", data: "JVBERi0xLjQK" }; // "%PDF-1.4\n"

/** The message a Gmail drafts.create / drafts.update was given, parsed. */
function storedGmailMessage(call: ProviderCall) {
  const raw = (JSON.parse(call.body!) as { message: { raw: string } }).message.raw;
  return parseEmail(atob(raw.replace(/-/g, "+").replace(/_/g, "/")));
}

const ascii = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A stored Gmail draft that already has one file (as Thunderbird would store it). */
const STORED_WITH_FILE = [
  "From: Harness Owner <owner@gmail-harness.example>",
  "To: kunde@example.com",
  "Subject: Ihr Angebot",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "Guten Tag, anbei das Angebot.",
  "--b1",
  'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="Preise.xlsx"',
  'Content-Disposition: attachment; filename="Preise.xlsx"',
  "Content-Transfer-Encoding: base64",
  "",
  "UEsDBAo=",
  "--b1--",
  "",
].join("\r\n");

function gmailDraftStore(initialRaw: string) {
  let raw = initialRaw;
  const handler = (call: ProviderCall) => {
    if (call.method === "GET" && call.url.startsWith(`${GMAIL}/drafts/d1`)) {
      return json({ id: "d1", message: { id: "m1", threadId: "t1", raw: b64url(raw), internalDate: "1767225600000" } });
    }
    if (call.method === "PUT" && call.url === `${GMAIL}/drafts/d1`) {
      const sent = (JSON.parse(call.body!) as { message: { raw: string } }).message.raw;
      raw = atob(sent.replace(/-/g, "+").replace(/_/g, "/"));
      return json({ id: "d1", message: { id: "m2", threadId: "t1" } });
    }
    return json({ error: { message: `unexpected ${call.method} ${call.url}` } }, 500);
  };
  return { handler, raw: () => raw };
}

// ── draft_create ────────────────────────────────────────────────────────────

Deno.test("Gmail draft_create stores an inline attachment and reports it", async () => {
  const inbox = await inboxRow("gmail");
  const { value, world } = await runTool(inbox, (call) => {
    if (call.method === "POST" && call.url === `${GMAIL}/drafts`) return json({ id: "d1", message: { id: "m1" } });
    return json({}, 500);
  }, () =>
    executeCreateDraft({
      to: ["kunde@example.com"],
      subject: "Ihr Angebot",
      body: "Guten Tag, anbei das Angebot.",
      attachments: [PDF],
    }, API_KEY) as Promise<Outcome>);

  assertEquals(value.logStatus, "success", JSON.stringify(value.result));
  const create = world.calls.find((c) => c.method === "POST")!;
  const stored = storedGmailMessage(create);
  assertEquals(stored.text, "Guten Tag, anbei das Angebot.");
  assertEquals(stored.attachments.map((a) => [a.filename, a.mimeType, ascii(a.content)]), [
    ["Angebot.pdf", "application/pdf", "%PDF-1.4\n"],
  ]);
  assertEquals(value.result.structuredContent.attachments, [{ filename: "Angebot.pdf", size_bytes: 9 }]);
});

Deno.test("draft_create without attachments is unchanged: no attachments key in the result", async () => {
  const inbox = await inboxRow("gmail");
  const { value, world } = await runTool(inbox, () => json({ id: "d1", message: { id: "m1" } }), () =>
    executeCreateDraft({ subject: "x", body: "y" }, API_KEY) as Promise<Outcome>);
  assertEquals(value.logStatus, "success");
  assert(!("attachments" in value.result.structuredContent));
  assertEquals(storedGmailMessage(world.calls[0]).attachments, []);
});

Deno.test("an invalid attachment is refused before anything is written", async () => {
  const inbox = await inboxRow("gmail");
  const { value, world } = await runTool(inbox, () => json({}, 500), () =>
    executeCreateDraft({
      subject: "x",
      body: "y",
      attachments: [{ filename: "a.pdf", mime_type: "application/pdf", data: "not base64!!" }],
    }, API_KEY) as Promise<Outcome>);
  assertEquals(value.result.isError, true);
  assertEquals(world.calls.length, 0, "no provider request at all");
});

// ── ChatGPT files ───────────────────────────────────────────────────────────

Deno.test("Outlook draft_create downloads a ChatGPT file and puts it on the draft", async () => {
  const inbox = await inboxRow("outlook");
  const { value, world } = await runTool(inbox, (call) => {
    if (call.url.startsWith(`${FILE_HOST}/`)) {
      return new Response(new TextEncoder().encode("Artikel;Preis\n"), { headers: { "content-type": "text/csv" } });
    }
    if (call.method === "POST" && call.url === `${GRAPH}/me/mailFolders/Drafts/messages`) {
      return json({ id: "o1", createdDateTime: "2026-10-15T10:00:00Z" }, 201);
    }
    return json({ error: { message: "unexpected" } }, 500);
  }, () =>
    executeCreateDraft({
      subject: "Preisliste",
      body: "Anbei.",
      files: [{ download_url: `${FILE_HOST}/f/abc?sig=1`, file_id: "file_abc", file_name: "Preise.csv" }],
    }, CHATGPT_KEY) as Promise<Outcome>);

  assertEquals(value.logStatus, "success", JSON.stringify(value.result));
  const create = world.calls.find((c) => c.url === `${GRAPH}/me/mailFolders/Drafts/messages`)!;
  const body = JSON.parse(create.body!) as { attachments: Record<string, unknown>[] };
  assertEquals(body.attachments, [{
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: "Preise.csv",
    contentType: "text/csv",
    contentBytes: btoa("Artikel;Preis\n"),
  }]);
  assertEquals(value.result.structuredContent.attachments, [{ filename: "Preise.csv", size_bytes: 14 }]);
});

Deno.test("files from a client other than ChatGPT is refused, and nothing is fetched or written", async () => {
  const inbox = await inboxRow("outlook");
  const { value, world } = await runTool(inbox, () => json({}, 500), () =>
    executeCreateDraft({
      subject: "x",
      body: "y",
      files: [{ download_url: `${FILE_HOST}/f`, file_id: "f" }],
    }, { ...API_KEY, name: "Claude Desktop" }) as Promise<Outcome>);
  assertEquals(value.result.isError, true);
  assert(value.result.content[0].text.includes("files takes files shared in ChatGPT"));
  assertEquals(world.calls.length, 0);
});

Deno.test("a ChatGPT file that cannot be downloaded means no draft", async () => {
  const inbox = await inboxRow("outlook");
  const { value, world } = await runTool(inbox, (call) => {
    if (call.url.startsWith(`${FILE_HOST}/`)) return new Response("expired", { status: 403 });
    return json({ id: "o1" }, 201);
  }, () =>
    executeCreateDraft({
      subject: "x",
      body: "y",
      files: [{ download_url: `${FILE_HOST}/f`, file_id: "f" }],
    }, CHATGPT_KEY) as Promise<Outcome>);
  assertEquals(value.result.isError, true);
  assertEquals(value.logErrorCode, "file_unavailable");
  assert(!world.calls.some((c) => c.host === "graph.microsoft.com"), "no draft was created");
});

// ── draft_update keeps what the draft has ───────────────────────────────────

Deno.test("Gmail full-body draft_update keeps the stored file and adds the new one", async () => {
  const inbox = await inboxRow("gmail");
  const store = gmailDraftStore(STORED_WITH_FILE);
  const { value } = await runTool(inbox, store.handler, () =>
    executeUpdateDraft({
      draft_id: "d1",
      body: "Guten Tag, anbei Angebot und Preise.",
      attachments: [PDF],
    }, API_KEY) as Promise<Outcome>);

  assertEquals(value.logStatus, "success", JSON.stringify(value.result));
  const after = parseEmail(store.raw());
  assertEquals(after.text, "Guten Tag, anbei Angebot und Preise.");
  assertEquals(after.attachments.map((a) => a.filename), ["Preise.xlsx", "Angebot.pdf"]);
  assertEquals(Array.from(after.attachments[0].content), [0x50, 0x4b, 0x03, 0x04, 0x0a], "bytes unchanged");
  assertEquals(value.result.structuredContent.attachments, [
    { filename: "Preise.xlsx", size_bytes: 5 },
    { filename: "Angebot.pdf", size_bytes: 9 },
  ]);
});

Deno.test("Gmail full-body draft_update without attachments no longer drops the stored file", async () => {
  const inbox = await inboxRow("gmail");
  const store = gmailDraftStore(STORED_WITH_FILE);
  const { value } = await runTool(inbox, store.handler, () =>
    executeUpdateDraft({ draft_id: "d1", body: "Neuer Text." }, API_KEY) as Promise<Outcome>);
  assertEquals(value.logStatus, "success", JSON.stringify(value.result));
  const after = parseEmail(store.raw());
  assertEquals(after.text, "Neuer Text.");
  assertEquals(after.attachments.map((a) => a.filename), ["Preise.xlsx"]);
});

Deno.test("Gmail full-body draft_update refuses, changing nothing, when the stored draft cannot be read", async () => {
  const inbox = await inboxRow("gmail");
  const { value, world } = await runTool(inbox, (call) => {
    if (call.method === "GET") return json({ error: { message: "backend" } }, 500);
    return json({ id: "d1" });
  }, () => executeUpdateDraft({ draft_id: "d1", body: "Neuer Text." }, API_KEY) as Promise<Outcome>);
  assertEquals(value.result.isError, true);
  assertEquals(value.logErrorCode, "draft_unreadable");
  assert(!world.calls.some((c) => c.method === "PUT"), "nothing was written");
});

Deno.test("Gmail draft_update with only attachments adds the file and keeps the body text", async () => {
  const inbox = await inboxRow("gmail");
  const store = gmailDraftStore(STORED_WITH_FILE);
  const { value } = await runTool(inbox, store.handler, () =>
    executeUpdateDraft({ draft_id: "d1", attachments: [PDF] }, API_KEY) as Promise<Outcome>);
  assertEquals(value.logStatus, "success", JSON.stringify(value.result));
  const after = parseEmail(store.raw());
  assertEquals(after.text, "Guten Tag, anbei das Angebot.");
  assertEquals(after.attachments.map((a) => a.filename), ["Preise.xlsx", "Angebot.pdf"]);
  assertEquals(value.result.structuredContent.attachments.map((a: { filename: string }) => a.filename), [
    "Preise.xlsx",
    "Angebot.pdf",
  ]);
});

Deno.test("Gmail subject-only draft_update on a draft with a file now succeeds and keeps it", async () => {
  const inbox = await inboxRow("gmail");
  const store = gmailDraftStore(STORED_WITH_FILE);
  const { value } = await runTool(inbox, store.handler, () =>
    executeUpdateDraft({ draft_id: "d1", subject: "Ihr Angebot (neu)" }, API_KEY) as Promise<Outcome>);
  assertEquals(value.logStatus, "success", JSON.stringify(value.result));
  const after = parseEmail(store.raw());
  assertEquals(after.attachments.map((a) => a.filename), ["Preise.xlsx"]);
  assert(!("attachments" in value.result.structuredContent), "nothing was added, so nothing is listed");
});

Deno.test("Outlook draft_update PATCHes the fields, then posts only the new file", async () => {
  const inbox = await inboxRow("outlook");
  const { value, world } = await runTool(inbox, (call) => {
    if (call.method === "GET") return json(graphMessage({ id: "o1", subject: "Angebot", content: "x" }));
    if (call.method === "PATCH") return json({ id: "o1" });
    if (call.method === "POST" && call.url === `${GRAPH}/me/messages/o1/attachments`) return json({ id: "a1" }, 201);
    return json({ error: { message: `unexpected ${call.method} ${call.url}` } }, 500);
  }, () =>
    executeUpdateDraft({ draft_id: "o1", body: "Neu.", attachments: [PDF] }, API_KEY) as Promise<Outcome>);

  assertEquals(value.logStatus, "success", JSON.stringify(value.result));
  const writes = world.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`);
  assertEquals(writes, [`PATCH ${GRAPH}/me/messages/o1`, `POST ${GRAPH}/me/messages/o1/attachments`]);
  const posted = JSON.parse(world.calls.find((c) => c.url.endsWith("/attachments"))!.body!);
  assertEquals([posted.name, posted.contentType, posted.contentBytes], ["Angebot.pdf", "application/pdf", PDF.data]);
});

// ── draft_reply ─────────────────────────────────────────────────────────────

Deno.test("Gmail draft_reply puts the file on the reply, threaded", async () => {
  const inbox = await inboxRow("gmail");
  const { value, world } = await runTool(inbox, (call) => {
    if (call.method === "GET" && call.url.startsWith(`${GMAIL}/messages/orig1?format=metadata`)) {
      return json({
        id: "orig1",
        threadId: "t9",
        payload: {
          headers: [
            { name: "From", value: "Kunde <kunde@example.com>" },
            { name: "Subject", value: "Anfrage" },
            { name: "Message-ID", value: "<orig1@example.com>" },
          ],
        },
      });
    }
    if (call.method === "GET" && call.url.startsWith(`${GMAIL}/messages/orig1`)) {
      return json({
        id: "orig1",
        threadId: "t9",
        payload: { mimeType: "text/plain", headers: [], body: { data: b64url("Bitte ein Angebot.") } },
      });
    }
    if (call.method === "POST" && call.url === `${GMAIL}/drafts`) return json({ id: "d7", message: { id: "m7" } });
    return json({ error: { message: `unexpected ${call.method} ${call.url}` } }, 500);
  }, () =>
    executeCreateReplyDraft({ message_id: "orig1", body: "Gern, anbei.", attachments: [PDF] }, {
      ...API_KEY,
      scopes: [...API_KEY.scopes, "manage:drafts"],
    }) as Promise<Outcome>);

  assertEquals(value.logStatus, "success", JSON.stringify(value.result));
  const create = world.calls.find((c) => c.method === "POST" && c.url === `${GMAIL}/drafts`)!;
  assertEquals((JSON.parse(create.body!) as { message: { threadId: string } }).message.threadId, "t9");
  const stored = storedGmailMessage(create);
  assertEquals(stored.attachments.map((a) => a.filename), ["Angebot.pdf"]);
  assert((stored.headers.get("in-reply-to") ?? [])[0]?.includes("orig1@example.com"));
  assertEquals(value.result.structuredContent.attachments, [{ filename: "Angebot.pdf", size_bytes: 9 }]);
});

// ── Size (found live 2026-10-15) ────────────────────────────────────────────
// Every inline file above ~3 MB used to come back as a JSON-RPC internal error:
// the base64 validator's regular expression overflowed the stack.

Deno.test("a 9 MB inline file is stored; 10.6 MB is refused in words, not as an internal error", async () => {
  const inbox = await inboxRow("gmail");
  const nine = btoa(String.fromCharCode(...new Uint8Array(3).fill(7))).repeat(3 * 1024 * 1024); // 9 MB decoded
  const { value, world } = await runTool(inbox, () => json({ id: "d1", message: { id: "m1" } }), () =>
    executeCreateDraft({
      subject: "Big",
      body: "y",
      attachments: [{ filename: "big.bin", mime_type: "application/octet-stream", data: nine }],
    }, API_KEY) as Promise<Outcome>);
  assertEquals(value.logStatus, "success", JSON.stringify(value.result).slice(0, 300));
  assertEquals(storedGmailMessage(world.calls[0]).attachments[0].content.length, 9 * 1024 * 1024);

  const tooBig = "QUJD".repeat(3_550_000);
  const refused = await runTool(inbox, () => json({}, 500), () =>
    executeCreateDraft({
      subject: "Too big",
      body: "y",
      attachments: [{ filename: "big.bin", mime_type: "application/octet-stream", data: tooBig }],
    }, API_KEY) as Promise<Outcome>);
  assertEquals(refused.value.logErrorCode, "attachment_too_large");
  assertEquals(refused.world.calls.length, 0);
});
